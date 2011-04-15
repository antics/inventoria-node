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

	switch (uri) {
	case '/':
		var query = url.parse(req.url, true).query;

		if (query && query.q)
			search(req, res, query.q);
		else
			renderHtml(res, 'index.html');
		break;
	case '/upload':
		upload(req, res);
		break;
	case '/approve':
		approve(req, res);
		break;
	default:
		// Test for static files
		//
		if(/static/i.test(uri))
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
		}
		// Else we have an item to display
		//
		else {
			var item_id = uri.slice(1);
			console.log(item_id);
			redis.hget('i:'+item_id, 'info', function (err, results) {
				if (results)
					renderHtml(res, 'item.html', {key: item_id, info: nl2br(results), title: results.substring(0, 30)});
				else {
					res.writeHead(404);
					res.end();
				}
					
			});
		}
		break;
	}

}).listen(8080);

sys.puts("Server running at http://localhost:8080/");

function search (req, res, query) {
	var
	words = query.toLowerCase().split(' '),	
	output = { query: query, items: [] };

	redis.sinter(words, function(err, item_ids) {
		// http://stackoverflow.com/questions/4288759/asynchronous-for-cycle-in-javascript
		// Better way some day?
		//
		console.log(item_ids);
		asyncLoop(item_ids.length,
				  function(loop) {
					  var item_id = item_ids[loop.iteration()];
					  redis.hget('i:'+item_id, 'info', function (err, item_info) {
						  output.items.push({
							  key: item_id,
							  info: item_info.substring(0, 70)
						  });
						  loop.next();
					  });
				  },
				  function() {
					  renderHtml(res, 'index.html', output);
				  });
	});	
}

function approve (req, res) {
	if (req.method == 'POST') {
		var
		form = new formidable.IncomingForm(),
		email_pattern =  /^([a-zA-Z0-9_\.\-\+])+\@(([a-zA-Z0-9\-])+\.)+([a-zA-Z0-9]{2,4})+$/;

		form.parse(req, function(err, fields) {
			
			if (fields.approve_items && fields.upload_session_id && fields.uploader_email.match(email_pattern)) {
				var special_key = Math.uuid(16);

				console.log(fields);

				var server = email.server.connect(o.smtp_data);
				
				redis.hset(special_key, 'upload_session_id', fields.upload_session_id, function(err, results) {
					redis.hset(special_key, 'uploader_email', fields.uploader_email, function(err, results) {
						redis.expire(special_key, o.approve_ttl);
						
						bind.toFile(o.templates_folder+'/email_sent.html', {special_key: special_key}, function callback(data) {
							res.writeHead(200, {
								'Set-Cookie': 'uploadSessionId='+
									fields.upload_session_id+'; expires=Thu, 01-Jan-1970 00:00:01 GMT;',
								'Content-Type': 'text/html'
							});
							res.end(data);
						});
					});
				});				
			} else if (fields.clear_items && fields.upload_session_id) {
				redis.lrange(fields.upload_session_id, 0, -1, function (err, item_ids) {
					if (!err) {
						item_ids.push(fields.upload_session_id);
						redis.del(item_ids, function (err, results) {});
					}
					bind.toFile(o.templates_folder+'/redirect.html', { location: '/upload' }, function callback(data) {
						res.writeHead(200, {
							'Set-Cookie': 'uploadSessionId='+
								fields.upload_session_id+'; expires=Thu, 01-Jan-1970 00:00:01 GMT;',
							'Content-Type': 'text/html'
						});
						res.end(data);
					});
				});
			} else {
				res.writeHead(302, {
					Location: '/upload'
				});
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
							redis.hget('i:'+item_id, 'info', function (err, item_info) {
								///// Add item id (key) to word sets
								//
								// This might be an ugly hack. Find a better wat to eliminate
								// whitespaces, line return etc. without adding empty strings
								// to the words_arr. However, only if there's speed or memory gains.
								var words = item_info.replace(/[^\wåäöÅÄÖ\s]/g, '');
								words = words.replace(/[\s]/g, ',')
								var words_arr = words.split(',');
								console.log('Array with words: '+words_arr);
								
								for (x in words_arr) {
									// How important words of char length < 3 can there be in the
									// dictionary of humanity?
									if (words_arr[x].length > 2) {
										console.log('Adding word to dictionary: '+words_arr[x]);
										redis.sadd(words_arr[x].toLowerCase(), item_id);
									}
								}

								// Add email and remove TTL
								redis.hset('i:'+item_id, 'email', session_data.uploader_email);

								// Add item to user set
								redis.sadd(session_data.uploader_email, item_id);

								output.items.push({
									key: item_id,
									info: item_info.substring(0, 70)
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
					// Check for name=image
					if (files.image && files.image != '') {
						// Resize Image
						im.resize({
							srcPath: files.image.path,
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
							});
						});
					} else
						redis.rpush(upload_session_id, key, function (err, results) {
							redis.expire(upload_session_id, o.approve_ttl,
										 function (err, results) { callback() });
						});
					
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
				results.forEach(function (val) {
					redis.hget('i:'+val, 'info', function (err, info) {
						output.items.push({
							key: val,
							info: info.substring(0, 70)
						});
						output.count++;
					});
				});

				bind.toFile(o.templates_folder+'/upload.html', output, function callback(data) {
					res.writeHead(200, {
						'Set-Cookie': 'uploadSessionId='+
							upload_session_id+'; Max-Age='+
							o.approve_ttl,
						'Content-Type': 'text/html'
					});
					res.end(data);
				});
			});
		} else
			renderHtml(res, 'upload.html');
	});
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

function renderHtml(res, file, json) {
 	bind.toFile(o.templates_folder+'/'+file, json, function callback(data) {
		res.writeHead(200, {'Content-Type': 'text/html'});
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

