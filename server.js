var sys = require("sys"),
http = require("http"),
url = require("url"),
path = require("path"),
fs = require("fs"),
formidable = require("formidable"),
im = require('imagemagick'),
uuid = require('./uuid'),
redis = require('redis').createClient(),
bind = require('bind'),
email = require('emailjs');

// Options
var o = {
	// 24h
	approve_ttl: 60*60*24,
	smtp_data: {
		user: 'user',
		password: 'passwd',
		host: 'mail.tele2.se',
		port: 587
	},
	templates_folder: './templates'
}

http.createServer(function(req, res) {
	var uri = url.parse(req.url).pathname;

	// Static files
	if(/static/i.test(uri) || uri == '/favicon.ico')
	{
		var filename = path.join(process.cwd(), uri);

		path.exists(filename, function(exists) {
			if(!exists) {
				res.writeHead(404);
				res.end();
				return;
			}
			
			fs.readFile(filename, "binary", function(err, file) {
				if(err) {
					res.writeHead(500, {"Content-Type": "text/plain"});
					res.end(err + "\n");
				}

				res.writeHead(200);
				res.end(file, "binary");
			});
		});
	} else {
		console.log('uri: '+uri);
		// URI routes
		switch(uri) {
		case '/':
			var query = url.parse(req.url, true).query;

			if (query && query.q)
				search(req, res, query.q);
			else
				renderHtml(res, 'index.html');
			break;
		case '/upload': upload(req, res); break;
		case '/approve': approve(req, res); break;
		case '/item_action': item_action(req, res); break;

		default:
			// Display item
			var item_id = uri.slice(1);
			
			redis.hgetall('i:'+item_id, function (err, item_data) {
				if (item_data.info) {
					renderHtml(res, 'item.html', {
						item_id: item_id,
						image_id: item_data.image_id,
						info: nl2br(item_data.info),
						title: item_data.info.substring(0, 30)
					});
				}
				else {
					res.writeHead(404);
					res.end();
				}
			});
			break;
		}
	}
}).listen(8080);

sys.puts("Server running at http://localhost:8080/");

function search (req, res, query) {
	var
	words = query.toLowerCase().split(' '),
	output = { query: query, items: [] };

	// Prefix dictionary to words.
	for (var x in words)
		words[x] = 'd:'+words[x];

	redis.sinter(words, function(err, item_ids) {
		// http://stackoverflow.com/questions/4288759/asynchronous-for-cycle-in-javascript
		// Better way some day?
		//
		console.log(item_ids);
		asyncLoop(item_ids.length, function(loop) {
			var item_id = item_ids[loop.iteration()];
			redis.hgetall('i:'+item_id, function (err, item_data) {
				output.items.push({
					item_id: item_id,
					item_info: item_data.info.substring(0, 70),
					image_id: item_data.image_id
				});
				loop.next();
			});
		}, function() {
			renderHtml(res, 'index.html', output);
		});
	});	
}

function upload (req, res) {
	// Set upload session id to retrieve recently uploaded items.
	var
	upload_session_id = getCookies(req).uploadSessionId;
	
	(function (callback) {
		if (req.method == 'POST') {
			var form = new formidable.IncomingForm();

			if (!upload_session_id)
				upload_session_id = Math.uuid(16);
	
			form.parse(req, function(err, fields, files) {
				var key = Math.uuid(6);

				if (fields.info.length > 3 && fields.info.length < 2000) {
					// Check for uploaded image
					if (files.uploaded_image) {
						// Resize Image
						im.resize({
							srcPath: files.uploaded_image.path,
							dstPath: './static/uploads/'+key+'.jpg',
							width: 640
						}, function (err) {
							// Thumbnail
							im.resize({
								srcPath: './static/uploads/'+key+'.jpg',
								dstPath: './static/uploads/_thb_'+key+'.jpg',
								width: 100
							}, function (err) {
								///// Add key to upload session list and let it expire.
								//
								// We put this here because saving files on disk is much
								// slower than doing Redis transactions in memory.
								// We have to wait until images are saved
								// before we can execute the callback function.
								redis.rpush(upload_session_id, key, function (err, results) {
									redis.expire(upload_session_id, o.approve_ttl,
												 function (err, results) { callback() });
								});

								// Save uploaded image id
								redis.hset('i:'+key, 'image_id', key);
							});
						});
					} else {
						redis.rpush(upload_session_id, key, function (err, results) {
							redis.expire(upload_session_id, o.approve_ttl,
										 function (err, results) { callback() });
						});

						if (fields.image_id)
							// Save cloned image id
							redis.hset('i:'+key, 'image_id', fields.image_id);
					}
					
					// Save actual item data
					redis.hset('i:'+key, 'info', fields.info);

					console.log('Item Key: '+key+'\nInfo: '+fields.info+'\nSession ID: '+
								upload_session_id+'\n');
				}
				else callback();
			});
		}
		else callback();
	})(function () {
		if (upload_session_id) {
			var output = {
				items: [],
				count: 0,
				upload_session_id: upload_session_id
			};
			
			redis.lrange(upload_session_id, 0, -1, function (err, results) {
				results.forEach(function (item_id) {
					redis.hgetall('i:'+item_id, function (err, item_data) {
						output.items.push({
							item_id: item_id,
							item_info: item_data.info.substring(0, 70),
							image_id: item_data.image_id
						});
						output.count++;
					});
				});

				renderHtml(res, 'upload.html', output, {
					'Set-Cookie': 'uploadSessionId='+
						upload_session_id+'; Max-Age='+
						o.approve_ttl,
					'Content-Type': 'text/html'
				});
			});
		} else
			renderHtml(res, 'upload.html');
	});
}

function approve (req, res) {
	if (req.method == 'POST') {
		var
		form = new formidable.IncomingForm(),
		email_pattern =  /^([a-zA-Z0-9_\.\-\+])+\@(([a-zA-Z0-9\-])+\.)+([a-zA-Z0-9]{2,4})+$/;

		form.parse(req, function(err, fields) {
			// Generate special key and send approval email
			//
			if (fields.approve_items && fields.upload_session_id && fields.uploader_email.match(email_pattern)) {
				var
				special_key = Math.uuid(16);
				//var server = email.server.connect(o.smtp_data);

				// Only redis and email sent to user will know the value of
				// our special key.
				//
				redis.hset(special_key, 'upload_session_id', fields.upload_session_id, function(err, results) {
					redis.hset(special_key, 'uploader_email', fields.uploader_email, function(err, results) {
						redis.expire(special_key, o.approve_ttl);
						
						renderHtml(res, 'email_sent.html', {special_key: special_key}, {
							'Set-Cookie': 'uploadSessionId='+
								fields.upload_session_id+'; expires=Thu, 01-Jan-1970 00:00:01 GMT;',
							'Content-Type': 'text/html'
						});
					});
				});				
			}
			// Clear items
			//
			else if (fields.clear_items && fields.upload_session_id) {
				redis.lrange(fields.upload_session_id, 0, -1, function (err, item_ids) {
					if (!err) {
						item_ids.push(fields.upload_session_id);
						redis.del(item_ids, function (err, results) {});
					}

					renderHtml(res, 'redirect.html', { location: '/upload' }, {
						'Set-Cookie': 'uploadSessionId='+
							fields.upload_session_id+'; expires=Thu, 01-Jan-1970 00:00:01 GMT;',
						'Content-Type': 'text/html'
					});
				});
			}
			// Do nothing if user hasn't filled in fields correctly, or if
			// there aren't anything to clear and so on...
			//
			else {
				res.writeHead(302, { Location: '/upload' });
				res.end();
			}
		});
	}

	if (req.method == 'GET') {
		var
		query = url.parse(req.url, true).query,
		output = {
				items: [],
				count: 0,
		};

		if (query && query.k) {
			// Get upload session id from special key
			redis.hgetall(query.k, function (err, session_data) {
				if (!err && session_data.upload_session_id) {

					// Return all uploaded item ids
					redis.lrange(session_data.upload_session_id, 0, -1, function (err, item_ids) {
						// Delete special key with session data and session data list.
						redis.del([query.k, session_data.upload_session]);

						// For each item, return item data
						item_ids.forEach(function (item_id) {
							redis.hgetall('i:'+item_id, function (err, item_data) {

								generateWords(item_data.info, function(word) {
									redis.sadd('d:'+word, item_id);
								});
								
								// Add email and remove TTL
								redis.hset('i:'+item_id, 'email', session_data.uploader_email);

								// Add item to user set (also in dictionary)
								redis.sadd('d:'+session_data.uploader_email, item_id);

								output.items.push({
									item_id: item_id,
									item_info: item_data.info.substring(0, 70),
									image_id: item_data.image_id
								});
								output.count++;
								
								renderHtml(res, 'approved.html', output);
							});
						});
					});
				} else {
					res.writeHead(404);
					res.end();
				}
			});
		} else {
			res.writeHead(404);					
			res.end();
		}
	}
}

function item_action (req, res) {
	if (req.method == 'POST') {
		var
		form = new formidable.IncomingForm();

		form.parse(req, function(err, fields) {
			if (fields.clone) {
				var upload_session_id = getCookies(req).uploadSessionId || '';
				
				redis.hgetall('i:'+fields.item_id, function(err, item_data) {
					renderHtml(res, 'upload.html', {
						upload_session_id: upload_session_id,
						item_info: item_data.info,
						image_id: item_data.image_id,
						items: []
					});
				});
			} else if (fields.throw_away) {
				// TODO:
				// Ask for email adress
				// Send email with special key
				redis.hgetall('i:'+fields.item_id, function(err, item_data) {
					if (item_data.info) {
						// Delete from d:[words]
						generateWords(item_data.info, function (word) {
							redis.srem('d:'+word, fields.item_id);
						});
						// Delete from d:email
						redis.srem('d:'+item_data.email, fields.item_id);
						// Delete item hash
						redis.del('i:'+fields.item_id);
					}
				});				
			} else {
				res.writeHead(404);					
				res.end();
			}
		});
	} else {
		res.writeHead(404);					
		res.end();
	}
}

function email_owner (req, res) {
	if (req.method == 'POST') {
		var
		form = new formidable.IncomingForm(),
		email_pattern =  /^([a-zA-Z0-9_\.\-\+])+\@(([a-zA-Z0-9\-])+\.)+([a-zA-Z0-9]{2,4})+$/;

		form.parse(req, function(err, fields) {
			
		});
	}
}

function generateWords (text, callback) {
	///// Add item id (key) to word sets
	//
	// This might be an ugly hack. Find a better wat to eliminate
	// whitespaces, line return etc. without adding empty strings
	// to the words_arr. However, only if there's speed or memory gains.
	var words = text.replace(/[^\wåäöÅÄÖ\s]/g, '');
	words = words.replace(/[\s]/g, ',')
	var words_arr = words.split(',');
	console.log('Array with words: '+words_arr);
	
	for (x in words_arr) {
		// How important words of char length < 3 can there be in the
		// dictionary of humanity?
		if (words_arr[x].length > 2) {
			console.log('Adding word to dictionary: '+words_arr[x]);
			callback(words_arr[x].toLowerCase());
		}
	}
}

function getQueryString(qstr) {
	var
	result = {},
	re = /([^&=]+)=([^&]*)/g,
	m;

	while (m = re.exec(qstr)) {
		result[decodeURIComponent(m[1]).replace(/[+]/g, ' ')] = decodeURIComponent(m[2]).replace(/[+]/g, ' ');
	}

	return result;
}

function renderHtml(res, file, data, header) {
	var header = header || {'Content-Type': 'text/html'};

 	bind.toFile(o.templates_folder+'/'+file, data, function callback(data) {
		res.writeHead(200, header);
		res.end(data);
	});
}

function getCookies(req) {
	var cookies = {};
	req.headers.cookie && req.headers.cookie.split(';').forEach(function( cookie ) {
		var parts = cookie.split('=');
		cookies[ parts[ 0 ].trim() ] = ( parts[ 1 ] || '' ).trim();
	});

	return cookies;
}

function asyncLoop(iterations, func, callback) {
	var index = 0;
	var done = false;
	var loop = {
		next: function() {
			if (done) {
				return;
			}

			if (index < iterations) {
				index++;
				func(loop);

			} else {
				done = true;
				callback();
			}
		},

		iteration: function() {
			return index - 1;
		},

		break: function() {
			done = true;
			callback();
		}
	};
	loop.next();
	return loop;
}

function nl2br (str) { return str.replace(/\n/g,'<br>'); }

