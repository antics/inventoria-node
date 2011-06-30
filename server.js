var sys = require("sys"),
http = require("http"),
url = require("url"),
path = require("path"),
fs = require("fs"),
formidable = require("formidable"),
im = require('imagemagick'),
redis = require('redis').createClient(),
bind = require('bind'),
email = require('emailjs'),
uuid = require('./uuid'),
config = require('./config');

var
conf = config.getConfig(),
msg = config.getMessages();

sys.puts('Running mode: '+conf.mode);
sys.puts('Server running at: http://'+conf.host);

http.createServer(function(req, res) {
	var uri = url.parse(req.url).pathname;

	// Static files
	if(/\/static\//i.test(uri) || uri == '/favicon.ico')
	{
		var filename = path.join(process.cwd(), uri);

		path.exists(filename, function(exists) {
			if(!exists) {
				showStatus(res, 404);
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

		redis.hgetall('u:'+uid, function (err, usd) {
			if (usd.email) {
				redis.smembers('d:'+usd.email, function (err, item_ids) {
					getItemDataFromIds(item_ids, function (items) {
						renderHtml(res, 'user.html', {
							items: items,
							uid: uid,
							title: usd.title,
							info: nl2br(usd.info)
						});
					});
				});
			} else
				showStatus(res, 404);

		});
	} else {
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
		case '/recycle': recycle(req, res); break;
		case '/clone': clone(req, res); break;
		case '/approve': approve(req, res); break;
		case '/email_owner': email_owner(req, res); break;
		case '/edit_info': edit_info(req, res); break;
			
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
				else
					showStatus(res, 404);
			});
			break;
		}
	}
}).listen(8080);

function search (req, res, query) {
	var
	words = query.toLowerCase().split(' '),
	output = { query: query, items: [], count: 0 };

	// Prefix dictionary to words.
	for (var x in words)
		words[x] = 'd:'+words[x];

	redis.sinter(words, function(err, item_ids) {
		asyncLoop(item_ids.length, function(loop) {
			var item_id = item_ids[loop.iteration()];
			redis.hgetall('i:'+item_id, function (err, item_data) {
				output.items.push({
					item_id: item_id,
					item_info: item_data.info.substring(0, 70),
					image_id: item_data.image_id
				});
				output.count++;
				loop.next();
			});
		}, function() {
			renderHtml(res, 'search.html', output);
		});
	});	
}

function upload (req, res) {
	// Set upload session id to retrieve recently uploaded items.
	var
	upload_session_id = getCookies(req).uploadSessionId;
	

	if (req.method == 'POST') {
		var form = new formidable.IncomingForm();

		upload_session_id = upload_session_id || Math.uuid(16);
		
		form.parse(req, function(err, fields, files) {
			var key = Math.uuid(6);

			// exec() in save or approve
			var r = redis.multi();
			
			switch (fields.act) {
			case 'save':

				// Save item info
				r.hset('i:'+key, 'info', fields.info);

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
								// Add key to upload session set and let it expire.
								r.sadd('s:'+upload_session_id, key);
								r.expire('s:'+upload_session_id, conf.ttl);

								// Save uploaded image id
								r.hset('i:'+key, 'image_id', key);

								r.exec(function () { output_html() });
							});
						});
					} else {
						r.sadd('s:'+upload_session_id, key);
						r.expire('s:'+upload_session_id, conf.ttl);

						if (fields.image_id)
							// Save cloned image id
							r.hset('i:'+key, 'image_id', fields.image_id);

						r.exec(function () { output_html() });
					}
				}
				else output_html();
				break;
			case 'approve':
				var is_validated =
					upload_session_id && fields.email.match(conf.validate.email);

				// Generate special key and send approval email
				//
				if (is_validated) {
					var secret_key = Math.uuid(16);

					fields.email = fields.email.toLowerCase();
					
					// Only redis and email sent to user will know the value of
					// our special key.
					//
					r.hmset('s:'+secret_key, {
						'upload_session_id': upload_session_id,
						'uploader_email': fields.email
					});
					r.expire('s:'+secret_key, conf.ttl);
					r.exec(function () {
						var headers = {
							to: fields.email,
							subject: msg.approve.subject,
							body: msg.approve.body+'http://'+conf.host+'/'+'approve?k='+secret_key+'&act=upload'
						}
						
						sendEmail(res, headers, function () {
							renderHtml(res, 'email_sent.html', {}, {
								'Set-Cookie': 'uploadSessionId='+
									upload_session_id+'; expires=Thu, 01-Jan-1970 00:00:01 GMT;',
								'Content-Type': 'text/html'
							});
						});
					});
				}
				else
					showStatus(res, 302, { Location: '/upload' }); 

				break;
			case 'clear':
				if (upload_session_id) {
					redis.smembers('s:'+upload_session_id, function (err, item_ids) {
						if (!err) {
							item_ids.push(upload_session_id);
							redis.del(item_ids);
						}
						
						renderHtml(res, 'redirect.html', { location: '/upload' }, {
							'Set-Cookie': 'uploadSessionId='+
								upload_session_id+'; expires=Thu, 01-Jan-1970 00:00:01 GMT;',
							'Content-Type': 'text/html'
						});
					});
				}
				else
					showStatus(res, 302, { Location: '/upload' });
				
				break;
			}
		});
	}
	else if (req.method == 'GET')
		output_html();
	else
		showStatus(res, 404);

	function output_html () {
		if (upload_session_id) {
			
			getItemDataFromSession(upload_session_id, function(items) {
				renderHtml(res, 'upload.html', {
					items: items,
					count: items.length,
				}, {
					'Set-Cookie': 'uploadSessionId='+
						upload_session_id+'; Max-Age='+
						conf.ttl,
					'Content-Type': 'text/html'
				});
			});
		} else
			renderHtml(res, 'upload.html');
	}
}

function recycle (req, res) {
	switch (req.method) {
	case 'POST':
		var form = new formidable.IncomingForm();
		
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
					if (fields.email && fields.email.match(conf.validate.email)) {
						
						fields.email = fields.email.toLowerCase();
						
						redis.hmset(['s:'+special_key, 'session_id', fields.session_id, 'email', fields.email], function(err, results) {
							redis.expire('s:'+special_key, conf.ttl);

							var headers = {
								to: fields.email,
								subject: msg.recycle.subject,
								body: msg.recycle.body+'http://'+conf.host+'/'+'approve?k='+special_key+'&act=recycle',
							}
							
							sendEmail(res, headers, function () {
								renderHtml(res, 'email_sent.html', {}, {
									'Set-Cookie': 'recycleSessionId='+
										fields.upload_session_id+'; expires=Thu, 01-Jan-1970 00:00:01 GMT;',
									'Content-Type': 'text/html'
								});
							});
						});
					} else
						showStatus(res, 302, { Location: '/recycle' });
					
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

			startSession(session_id, 'recycleSessionId', q.item_id, conf.ttl, function (httpHeader) {
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
		} else
			showStatus(res, 404);
	} else
		showStatus(res, 405);
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
								// Increment user count
								redis.incr('count:uid', function (err, uid) {
									console.log('Adding user: '+uid);
									redis.set('e:'+session_data.uploader_email, uid);
									redis.hset('u:'+uid, 'email', session_data.uploader_email);
									redis.hset('u:'+uid, 'title', uid+"'s:");
									redis.hset('u:'+uid, 'info', '');
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
										// Add uid and remove TTL
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
					} else
						showStatus(res, 404);
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
					} else
						showStatus(res, 404);
				});
				break;

			case 'edit_info':
				redis.hgetall('s:'+query.k, function (err, session_data) {
					if (!err) {
						redis.hmset('u:'+session_data.uid, { title: session_data.title, info: session_data.info });
						redis.del('s:'+query.k);

						showStatus(res, 302, { Location: '/u/'+session_data.uid });
					} else
						showStatus(res, 404);
				});
				break;
			}
		} else
			showStatus(res, 404);
	} else
		showStatus(res, 402);
}

function email_owner (req, res) {
	if (req.method == 'POST') {
		var
		form = new formidable.IncomingForm();

		form.parse(req, function(err, f) {
			var is_validated =
				f.email && f.email.match(conf.validate.email) &&
				f.message && f.uid && f.item_id && f.subject;
			
			if (is_validated) {
				redis.hget('u:'+f.uid, 'email', function (err, owner_email) {
					if (email) {
						var headers = {
							from: f.email,
							to: owner_email,
							subject: msg.email_owner.subject+f.subject.replace(/[\r\n]/g, ''),
							body: f.message+msg.email_owner.body+'http://'+conf.host+'/'+f.item_id
						}
						
						sendEmail(res, headers, function () {
							renderHtml(res, 'email_owner.html', {
								item_id: f.item_id,
								message: nl2br(f.message)
							});
						});
					} else
						showStatus(res, 503);
				});
			} else
				showStatus(res, 302, { Location: req.headers.referer });
		});
	} else
		showStatus(res, 405);
}

// TODO: Continue...
function edit_info (req, res) {
	if (req.method == 'POST') {
		var
		special_key = Math.uuid(16),
		form = new formidable.IncomingForm();

		form.parse(req, function(err, f) {
			var is_validated =
				f.uid && f.email && f.email.match(conf.validate.email) &&
				f.title && f.info;

			if (is_validated) {
				redis.hget('u:'+f.uid, 'email', function (err, email) {
					if (email == f.email) {
						redis.hmset('s:'+special_key, { title: f.title, info: f.info, uid: f.uid }, function () {
							redis.expire('s:'+special_key, conf.ttl);

							var headers = {
								to: f.email,
								subject: msg.edit_info.subject,
								body: msg.edit_info.body+'http://'+conf.host+'/approve?k='+special_key+'&act=edit_info'
							}

							sendEmail(res, headers, function () {
								renderHtml(res, 'email_sent.html');
							});
						});
					} else
						showStatus(res, 302, { Location: req.url });
				});
			} else
				showStatus(res, 302, { Location: req.url });
		});
	}

	if (req.method == 'GET') {
		var q = url.parse(req.url, true).query;
		
		redis.hgetall('u:'+q.uid, function (err, itd) {
			renderHtml(res, 'edit_info.html', { title: itd.title, info: itd.info, uid: q.uid });
		});
	} 
}

function sendEmail (res, headers, callback) {

	if (conf.mode == 'production') {
		var server  = email.server.connect(conf.email.options);

		if (headers.from)
			conf.email.headers.from = headers.from;
		if (headers.to)
			conf.email.headers.to = headers.to;
		if (headers.subject)
			conf.email.headers.subject = headers.subject;
		if (headers.body)
			conf.email.headers.text = headers.body;
		
		server.send(conf.email.headers, function(err, message) {
			if (!err)
				callback();
			else {
				sys.puts('503 Service Unavailable: email');
				sys.puts(err);
				
				res.writeHead(503);
				res.end('503 Service Unavailable: email');
			}
		});
	} else if (conf.mode == 'dev') {
		console.log(headers);
		callback();
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
					uid: item_data.uid,
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
	
	for (x in words_arr) {
		// How important words of char length < 3 can there be in the
		// dictionary of humanity?
		if (words_arr[x].length > 2) {
			callback(words_arr[x].toLowerCase());
		}
	}
}

function renderHtml(res, file, data, header) {
	var header = header || {'Content-Type': 'text/html'};

 	bind.toFile(conf.templates+'/'+file, data, function callback(data) {
		res.writeHead(200, header);
		res.end(data);
	});
}

function showStatus (res, code, header) {
	var header = header || {};
	
	res.writeHead(code, header);
	res.end();
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

