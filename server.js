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
	if(/\/static\//i.test(uri) || uri == '/favicon.ico')
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
	// User page
	else if (/\/u\//i.test(uri)) {
		var uid = uri.substr(uri.lastIndexOf('/')+1);

		redis.hget('u:'+uid, 'email', function (err, email) {
			if (email) {
				redis.smembers('d:'+email, function (err, item_ids) {
					console.log(item_ids);
					getItemDataFromIds(item_ids, function (items) {
						renderHtml(res, 'user.html', {
							items: items,
							uid: uid
						});
					});
				});
			} else {
				res.writeHead(404);
				res.end();
			}
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
		case '/recycle': recycle(req, res); break;
		case '/clone': clone(req, res); break;
		case '/item_action': item_action(req, res); break;
		case '/action': action(req, res, uri); break;
			
		default:
			// Display item
			var item_id = uri.slice(1);
			
			redis.hgetall('i:'+item_id, function (err, item_data) {
				if (item_data.info) {
					renderHtml(res, 'item.html', {
						uid: item_data.uid,
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

			upload_session_id = upload_session_id || Math.uuid(16);
	
			form.parse(req, function(err, fields, files) {
				var key = Math.uuid(6);

				switch (fields.act) {
				case 'save':
					if (fields.info.length > 3 && fields.info.length < 320) {
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
									///// Add key to upload session set and let it expire.
									//
									// We put this here because saving files on disk is much
									// slower than doing Redis transactions in memory.
									// We have to wait until images are saved
									// before we can execute the callback function.
									redis.sadd('s:'+upload_session_id, key, function (err, results) {
										redis.expire(upload_session_id, o.approve_ttl,
													 function (err, results) { callback() });
									});

									// Save uploaded image id
									redis.hset('i:'+key, 'image_id', key);
								});
							});
						} else {
							redis.sadd('s:'+upload_session_id, key, function (err, results) {
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
					break;
				case 'approve':
					var email_pattern =  /^([a-zA-Z0-9_\.\-\+])+\@(([a-zA-Z0-9\-])+\.)+([a-zA-Z0-9]{2,4})+$/;
					// Generate special key and send approval email
					//
					if (fields.upload_session_id && fields.email.match(email_pattern)) {
						var
						special_key = Math.uuid(16);
						//var server = email.server.connect(o.smtp_data);
						
						// Only redis and email sent to user will know the value of
						// our special key.
						//
						redis.hmset(['s:'+special_key, 'upload_session_id', fields.upload_session_id,
									 'uploader_email', fields.email], function(err, results) {
										 redis.expire('s:'+special_key, o.approve_ttl);
										 
										 renderHtml(res, 'email_sent.html', {
											 approve_uri: '/approve?k='+special_key+'&act=upload'}, {
											 'Set-Cookie': 'uploadSessionId='+
												 fields.upload_session_id+'; expires=Thu, 01-Jan-1970 00:00:01 GMT;',
											'Content-Type': 'text/html'
										 });
									 });
					}
					else {
						res.writeHead(302, { Location: '/upload' });
						res.end();
					}
					break;
				case 'clear':
					if (fields.upload_session_id) {
						redis.smembers('s:'+fields.upload_session_id, function (err, item_ids) {
							if (!err) {
								item_ids.push(fields.upload_session_id);
								redis.del(item_ids);
							}
							
							renderHtml(res, 'redirect.html', { location: '/upload' }, {
								'Set-Cookie': 'uploadSessionId='+
									fields.upload_session_id+'; expires=Thu, 01-Jan-1970 00:00:01 GMT;',
								'Content-Type': 'text/html'
							});
						});
					}
					else {
						res.writeHead(302, { Location: '/upload' });
						res.end();
					}
					break;
				}
			});
		}
		else callback();
	})(function () {
		if (upload_session_id) {
			
			getItemDataFromSession(upload_session_id, function(items) {
				renderHtml(res, 'upload.html', {
					items: items,
					count: items.length,
					upload_session_id: upload_session_id
				}, {
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
	if (req.method == 'GET') {
		var
		query = url.parse(req.url, true).query;

		if (query && query.k && query.act) {
			switch (query.act) {
			case 'upload': 
				// Get upload session id from special key
				redis.hgetall('s:'+query.k, function (err, session_data) {
					if (!err && session_data.upload_session_id && session_data.uploader_email) {
						redis.get('e:'+session_data.uploader_email, function (err, uid) {

							if (!uid) {
								redis.incr('count:uid', function (err, uid) {
									redis.set('e:'+session_data.uploader_email, uid);
									redis.hset('u:'+uid, 'email', session_data.uploader_email);
									save(uid);
								});
							} else
								save(uid);

							function save (uid) {
								getItemDataFromSession(session_data.upload_session_id, function (items) {
									items.forEach(function (item) {
										generateWords(item.item_info_full, function(word) {
											redis.sadd('d:'+word, item.item_id);
										});
										// Add email and remove TTL
										redis.hset('i:'+item.item_id, 'uid', uid);
										
										// Add item to user set (also in dictionary)
										redis.sadd('d:'+session_data.uploader_email, item.item_id);
									});
									
									// Delete session keys
									redis.del(['s:'+session_data.upload_session_id, 's:'+query.k]);
									
									renderHtml(res, 'approved.html', {
										items: items,
										count: items.length,
										uid: uid 
									});
								});
							}
						});						
					} else {
						res.writeHead(404);
						res.end();
					}
				});

				break;
			case 'recycle':
				redis.hgetall('s:'+query.k, function (err, session_data) {
					if (!err && session_data.session_id) {
						getItemDataFromSession(session_data.session_id, function (items) {
							redis.get('e:'+session_data.email, function (err, uid) {
								items.forEach(function (item) {
									if (uid == item.uid) {
										generateWords(item.item_info_full, function(word) {
											redis.srem('d:'+word, item.item_id);
										});
										
										redis.del('i:'+item.item_id);
										
										redis.srem('d:'+session_data.email, item.item_id);
									}
								});
								
								redis.del(['s:'+session_data.session_id, 's:'+query.k]);
								
								renderHtml(res, 'deleted.html', { items: items, count: items.length });
							});
						});
					} else {
						res.writeHead(404);
						res.end();
					}
				});
				break;
			}
		} else {
			res.writeHead(404);			
			res.end();
		}
	} else {
		res.writeHead(402);
		res.end();
	}
}

function recycle (req, res) {
	switch (req.method) {
	case 'POST':
		var
		form = new formidable.IncomingForm(),
		email_pattern =  /^([a-zA-Z0-9_\.\-\+])+\@(([a-zA-Z0-9\-])+\.)+([a-zA-Z0-9]{2,4})+$/;
		
		form.parse(req, function(err, fields) {
			if (fields.session_id) {
				switch(fields.act) {
				case 'regret':
					endSession(fields.session_id, 'recycleSessionId', function (httpHeader) {
						renderHtml(res, 'redirect.html', { location: '/recycle' }, httpHeader);
					});
					
					break;
				case 'recycle':
					var special_key = Math.uuid(16);
					if (fields.email) {
						redis.hmset(['s:'+special_key,
									'session_id', fields.session_id,
									 'email', fields.email],
									function(err, results) {
										redis.expire('s:'+special_key, o.approve_ttl);
										
										renderHtml(res, 'email_sent.html', {
											approve_uri: '/approve?k='+special_key+'&act=recycle'}, {
												'Set-Cookie': 'recycleSessionId='+
													fields.upload_session_id+'; expires=Thu, 01-Jan-1970 00:00:01 GMT;',
												'Content-Type': 'text/html'
											});
									});
					} else {
						res.writeHead(302, { Location: '/recycle' });
						res.end();
					}
					
					console.log('recycle');
					// Send email with special key
					break;
				}
			}
		});

		break;

	case 'GET':
		var
		q = url.parse(req.url, true).query,
		session_id = getCookies(req).recycleSessionId;

		if (q.item_id) {
			session_id = session_id || Math.uuid(16); 

			startSession(session_id, 'recycleSessionId', q.item_id, o.approve_ttl, function (httpHeader) {
				getItemDataFromSession(session_id, function (items) {
					renderHtml(res, 'recycle.html', {
						items: items,
						count: items.length,
						session_id: session_id
					}, httpHeader);
				});
			});				
		} else {
			if (session_id)
				getItemDataFromSession(session_id, function (items) {
					renderHtml(res, 'recycle.html', {
						items: items,
						count: items.length,
						session_id: session_id
					});
				});
			else
				renderHtml(res, 'recycle.html', { items: [], count: 0 });
		}
		
		break;
	}
}

function clone(req, res) {
	if (req.method == 'GET') {
		var
		q = url.parse(req.url, true).query;

		if (q.item_id) {
			var upload_session_id = getCookies(req).uploadSessionId || '';

			redis.hgetall('i:'+q.item_id, function(err, item_data) {
				renderHtml(res, 'clone.html', {
					upload_session_id: upload_session_id,
					item_info: item_data.info,
					image_id: item_data.image_id,
				});
			});
		} else {
			res.writeHead(404);
			res.end();
		}
	} else {
		res.writeHead(405);					
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

function endSession (session_id, cookie, callback) {
	var httpHeader = {
		'Set-Cookie': cookie+'='+
			session_id+'; expires=Thu, 01-Jan-1970 00:00:01 GMT;',
		'Content-Type': 'text/html'
	}

	redis.del('s:'+session_id, function (err, results) {
		callback(httpHeader)
	});
}

function startSession (session_id, cookie, data, ttl, callback) {
	var httpHeader = {
		'Set-Cookie': cookie+'='+session_id+'; Max-Age='+ttl,
		'Content-Type': 'text/html'
	}
	
	if (typeof data === 'array') {
		redis.hmset('s:'+session_id, data, function (err, result) {
			redis.expire('s:'+session_id, ttl);
			callback(httpHeader);
		});
	}
	if (typeof data === 'string' || typeof data === 'number') {
		redis.sadd('s:'+session_id, data, function (err, result) {
			redis.expire('s:'+session_id, ttl);
			callback(httpHeader);
		});
	}
}

function getItemDataFromIds(item_ids, callback) {
	var items = [];
	
	asyncLoop(item_ids.length, function(loop) {
		var item_id = item_ids[loop.iteration()];
		redis.hgetall('i:'+item_id, function (err, item_data) {
			items.push({
				email: item_data.email,
				id: item_id,
				info_legend: item_data.info.substring(0, 70),
				info: item_data.info,
				image_id: item_data.image_id
			});
			loop.next();
		});
	}, function() {
		callback(items);
	});			
}

function getItemDataFromSession (session_id, callback) {
	var items = [];
	
	getItemIdsFromSession(session_id, function (item_ids) {
		asyncLoop(item_ids.length, function(loop) {
			var item_id = item_ids[loop.iteration()];
			redis.hgetall('i:'+item_id, function (err, item_data) {
				items.push({
					email: item_data.email,
					item_id: item_id,
					item_info: item_data.info.substring(0, 70),
					item_info_full: item_data.info,
					image_id: item_data.image_id
				});
				loop.next();
			});
		}, function() {
			callback(items);
		});
	});
}

function getItemIdsFromSession (session_id, callback) {
	redis.smembers('s:'+session_id, function (err, item_ids) {
		callback(item_ids);
	});
}

function getItemsFromSpecialKey (special_key, callback) {
	// Get session data from special key
	redis.hgetall('s:'+special_key, function (err, session_data) {
		if (!err && session_data.session_id) {
			getItemIdsFromSession(session_data.session_id, function (item_ids) {
				callback(item_ids, session_data);
			});
		}
	});
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

// http://stackoverflow.com/questions/4288759/asynchronous-for-cycle-in-javascript
// Better way some day?
//
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

