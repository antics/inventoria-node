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
config = require('./config'),
flattr = require('./flattr');

var
conf = config.getConfig(),
msg = config.getMessages();

sys.puts('Running mode: '+conf.mode);
sys.puts('Server running at: http://'+conf.host);

//
// Http Server reading pathnames and passing the
// requests on to the correct function.
//
http.createServer(function(req, res) {
	var uri = url.parse(req.url).pathname;

	//
	// Open and send static files.
	//
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
	
	//
	// Show user page /u/<user_id>
	//
	else if (/\/u\//i.test(uri)) {
		var uid = uri.substr(uri.lastIndexOf('/')+1);

		// Get user fields fom u:<uid>
		redis.hgetall('u:'+uid, function (err, usd) {
			if (usd.title) {
				// Get all items in dictionary uploaded by <uid>
				redis.smembers('d:u:'+uid, function (err, item_ids) {
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
	}
	
	//
	// Show one of the predefined URI routes.
	//
	else {
		switch(uri) {
		case '/':
			var query = url.parse(req.url, true).query;

			// User did a search
			if (query && query.q)
				search(req, res, query.q);
			// Front page with the 50 latests items.
			else {
				redis.zrevrange('items', 0, 50, function (err, item_ids) {
					getItemDataFromIds(item_ids, function (items) {
						renderHtml(res, 'index.html', { items: items });
					});
				})
			}
			break;
		case '/upload': upload(req, res); break;
		case '/recycle': recycle(req, res); break;
		case '/bulk_approve': bulk_approve(req, res); break;
		case '/approve':
			var approve = new Approve();
			approve.act(req, res);
			break;
		case '/clone': clone(req, res); break;
		case '/email_owner': email_owner(req, res); break;
		case '/edit_info': edit_info(req, res); break;
		case '/flattr': go_flattr(req, res); break;
			
		default:
			//
			// Display item page /<item_id>
			//
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

// 
// This function handles search queries
//
function search (req, res, query) {
	var
	words = query.toLowerCase().split(' '),
	output = { query: query, items: [], count: 0 };

	// Prepend dictionary prefix d: to words.
	for (var x in words) {
		words[x] = words[x].replace(/[^\wåäöÅÄÖ:\s]/g, '');
		words[x] = 'd:'+words[x];
	}

	// Pull an intersection of the dictionary based on words
	// in the query.
	redis.sinter(words, function(err, item_ids) {
		asyncLoop(item_ids.length, function(loop) {
			var item_id = item_ids[loop.iteration()];
			redis.hgetall('i:'+item_id, function (err, item_data) {
				if (item_data) {
					output.items.push({
						id: item_id,
						info: item_data.info.substring(0, 70),
						image_id: item_data.image_id
					});
					output.count++;
				} 
				loop.next();
			});
		}, function() {
			renderHtml(res, 'search.html', output);
		});
	});	
}

//
// This function handles item uploads saving item data and item
// image in database. The value in the act variable in POST tells
// the function what act to do.
//
function upload (req, res) {
	// Set upload session id to retrieve recently uploaded items.
	var uploadSessionId = getCookies(req).uploadSessionId;
	
	if (req.method == 'POST') {

		var form = new formidable.IncomingForm();

		uploadSessionId = uploadSessionId || Math.uuid(16);
		
		form.parse(req, function(err, fields, files) {
			switch (fields.act) {
			case 'save':
				save(fields, files);
				break;
			case 'approve':
				approve(fields, files);
				break;
			case 'clear':
				clear();
				break;
			}
		});
	}
	else if (req.method == 'GET')
		output_upload();
	else
		showStatus(res, 405);

	function save (fields, files, callback) {
		createKey(6, true, function (key) {
			var r = redis.multi();

			fields.info = fields.info.replace(/[<>]/g, '');
			
			if (fields.info.length > 3 && fields.info.length < 320) {

				// Save item info
				r.hset('i:'+key, 'info', fields.info);
				
				// Check for uploaded image
				if (files.uploaded_image && files.uploaded_image.name) {
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
							r.sadd('s:'+uploadSessionId, key);
							r.expire('s:'+uploadSessionId, conf.ttl);

							// Save uploaded image id
							r.hset('i:'+key, 'image_id', key);

							r.exec(function () {
								// First timer/single upload
								if (fields.email)
									approve(fields, files);
								else
									output_upload();
							});
						});
					});
				} else {
					r.sadd('s:'+uploadSessionId, key);
					r.expire('s:'+uploadSessionId, conf.ttl);

					if (fields.image_id)
						// Save cloned image id
						r.hset('i:'+key, 'image_id', fields.image_id);

					r.exec(function () { output_upload() });
				}

			}
			else output_upload();
		});
	}

	function approve (fields, files) {
		var is_validated =
			uploadSessionId && fields.email.match(conf.validate.email);
		var r = redis.multi();

		// Generate special key and send approval email
		if (is_validated) {
			var secret_key = Math.uuid(16);

			fields.email = fields.email.toLowerCase();
			
			// Only redis and email sent to user will know the value of
			// our special key.
			r.hmset('s:'+secret_key, {
				'uploadSessionId': uploadSessionId,
				'email': fields.email
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
						'Set-Cookie': setCookie('uploadSessionId', uploadSessionId, -1),
						'Content-Type': 'text/html'
					});
				});
			});
		}
		else
			showStatus(res, 302, { Location: '/upload' }); 
	}

	function clear () {
		if (uploadSessionId) {
			redis.smembers('s:'+uploadSessionId, function (err, item_ids) {
				if (!err) {
					item_ids.push(uploadSessionId);
					redis.del(item_ids);
				}
				
				renderHtml(res, 'redirect.html', { location: '/upload' }, {
					'Set-Cookie': setCookie('uploadSessionId', uploadSessionId, -1),
					'Content-Type': 'text/html'
				});
			});
		}
		else
			showStatus(res, 302, { Location: '/upload' });
	}
	
	function output_upload () {
		if (uploadSessionId) {
			getItemDataFromSession(uploadSessionId, function(items) {
				var httpHeader =  {
					'Set-Cookie': setCookie('uploadSessionId', uploadSessionId, conf.ttl),
					'Content-Type': 'text/html'
				};
				renderHtml(res, 'upload.html', { items: items, count: items.length, uploadSessionId: uploadSessionId }, httpHeader);
			});
		} else
			renderHtml(res, 'upload.html');
	}
}

//
// Function to handle removal of items from DB
//
function recycle (req, res) {
	var recycleSessionId = getCookies(req).recycleSessionId;

	if (req.method == 'POST') {
		var form = new formidable.IncomingForm();
		
		form.parse(req, function(err, fields) {
			if (recycleSessionId) {
				var httpHeader =  {
					'Set-Cookie': setCookie('recycleSessionId', recycleSessionId, -1),
					'Content-Type': 'text/html'
				};

				// Dontwanna recycle. 
				if (fields.act == 'regret') {
					// Delete session from DB
					redis.del('s:'+recycleSessionId);
					// Send request to delete recycleSessionId cookie.
					renderHtml(res, 'redirect.html', { location: '/recycle' }, httpHeader);
				}

				// Lets recycle.
				if (fields.act == 'recycle') {
					var secret_key = Math.uuid(16);
					var r = redis.multi();

					// Alright, user gave us an email address. Lets check if it's valid.
					if (fields.email && fields.email.match(conf.validate.email)) {
						
						fields.email = fields.email.toLowerCase();

						// Save session data in DB to secret key.
						r.hmset('s:'+secret_key, {
							'recycleSessionId': recycleSessionId,
							'email': fields.email
						});						
						r.expire('s:'+secret_key, conf.ttl);
						// Execute DB commands, send email and tell user to check her email.
						r.exec(function () {
							var headers = {
								to: fields.email,
								subject: msg.recycle.subject,
								body: msg.recycle.body+'http://'+conf.host+'/'+'approve?k='+secret_key+'&act=recycle',
							}
							
							sendEmail(res, headers, function () {
								renderHtml(res, 'email_sent.html', {}, httpHeader);
							});
						});
					} else
						showStatus(res, 302, { Location: '/recycle' });
				}
			}
		});
	}
	//
	// Create recycle session in DB and set recycleSessionId cookie.
	//
	else if (req.method == 'GET') {
		var q = url.parse(req.url, true).query;

		if (q.item_id) {
			recycleSessionId = recycleSessionId || Math.uuid(16); 

			var r = redis.multi();
			r.sadd('s:'+recycleSessionId, q.item_id);
			r.expire('s:'+recycleSessionId, conf.ttl);
			r.exec(function () {
				output_html();
			});			
		} else {
			if (recycleSessionId)
				output_html();
			else
				renderHtml(res, 'recycle.html', { items: [], count: 0 });
		}
	}
	else
		showStatus(res, 405);

	function output_html () {
		var httpHeader =  {
			'Set-Cookie': setCookie('recycleSessionId', recycleSessionId, conf.ttl),
			'Content-Type': 'text/html'
		};
		
		getItemDataFromSession(recycleSessionId, function (items) {
			renderHtml(res, 'recycle.html', { items: items, count: items.length }, httpHeader);
		});				
	}
}

//
// This function handles bulk approving of stuff the user does in the app.
//
function bulk_approve (req, res) {
	var cookies = getCookies(req);

	if (req.method == 'GET') {
		getItemDataFromSession(cookies.uploadSessionId, function (upload_items) {
			getItemDataFromSession(cookies.recycleSessionId, function (recycle_items) {
				renderHtml(res, 'bulk_approve.html', {
					cookies: cookies,
					upload_items: upload_items,
					recycle_items: recycle_items
				});
			});
		});
	}
	else if (req.method == 'POST') {
		var form = new formidable.IncomingForm();

		form.parse(req, function(err, fields) {
			if (fields.email && fields.email.match(conf.validate.email)) {
				var
				secret_key = Math.uuid(16),
				httpHeader = ['Content-Type', 'text/html'],
				r = redis.multi(),
				secrets = {};

				fields.email = fields.email.toLowerCase();
				
				if (cookies.uploadSessionId) {
					secrets['uploadSessionSecret'] = Math.uuid(16);
					r.hmset('s:'+secrets['uploadSessionSecret'], {
						'uploadSessionId': cookies.uploadSessionId,
						'email': fields.email
					});
					r.expire('s:'+secrets['uploadSessionSecret'], conf.ttl);
					
					httpHeader.push(['Set-Cookie', setCookie('uploadSessionId', cookies.uploadSessionId, -1)]);
				}

				if (cookies.recycleSessionId) {
					secrets['recycleSessionSecret'] = Math.uuid(16);
					r.hmset('s:'+secrets['recycleSessionSecret'], {
						'recycleSessionId': cookies.recycleSessionId,
						'email': fields.email
					});
					r.expire('s:'+secrets['recycleSessionSecret'], conf.ttl);
					
					httpHeader.push(['Set-Cookie', setCookie('recycleSessionId', cookies.recycleSessionId, -1)]);
				}

				r.hmset('s:'+secret_key, secrets);
				r.expire('s:'+secret_key, conf.ttl);
				r.exec(function () {
					var headers = {
						to: fields.email,
						subject: msg.bulk.subject,
						body: msg.bulk.body+'http://'+conf.host+'/'+'approve?k='+secret_key+'&act=bulk_approve',
					}
					
					sendEmail(res, headers, function () {
						renderHtml(res, 'email_sent.html', {}, httpHeader);
					});
				});
			} else
				showStatus(res, 302, { Location: '/bulk_approve'});
		});
	} else
		showStatus(res, 405);
}

function Approve () {

	var self = this;
	
	self.act = function (req, res) {
		if (req.method == 'GET') {
			var query = url.parse(req.url, true).query;

			if (query && query.k && query.act) {
				switch (query.act) {
				case 'upload': 
					self.upload(query.k, function (items, uid) {
						renderHtml(res, 'upload_approved.html', {
							items: items,
							count: items.length,
							uid: uid 
						});
					});
					break;
				case 'recycle':
					self.recycle(query.k, function (items) {
						renderHtml(res, 'deleted.html', { items: items, count: items.length });
					});
					break;
				case 'bulk_approve':
					self.bulk_approve(query.k, function () {
						renderHtml(res, 'bulk_approved.html');
					});
					break;
				case 'edit_info':
					self.edit_info(query.k);
					break;
				}
			} else
				showStatus(res, 404);
		} else
			showStatus(res, 402);
	}
	
	self.upload = function (secret_key, callback) {
		// Get upload session id from special key
		redis.hgetall('s:'+secret_key, function (err, session_data) {
			if (!err && session_data.uploadSessionId && session_data.email) {
				redis.get('e:'+session_data.email, function (err, uid) {
					
					if (!uid) {
						// Increment user count
						redis.incr('count:uid', function (err, uid) {
							console.log('Adding user: '+uid);
							
							var m = redis.multi();
							// Add email key to e: namespace
							m.set('e:'+session_data.email, uid);
							m.hmset('u:'+uid, {
								'email': session_data.email,
								'title': uid+"'s:",
								'info': ''
							});
							m.exec();
							
							save(uid);
						});
					} else
						save(uid);
					
					function save (uid) {
						getItemDataFromSession(session_data.uploadSessionId, function (items) {
							items.forEach(function (item) {
								generateWords(item.info, function(word) {
									redis.sadd('d:'+word, item.id);
								});
								// Add uid and remove TTL
								redis.hset('i:'+item.id, 'uid', uid);
								
								// Add item to user set (also in dictionary) to make
								// it searchable by uid
								redis.sadd('d:u:'+uid, item.id);

								// Count and add to items "list"
								redis.incr('count:items', function (err, count) {
									redis.zadd('items', count, item.id);
								});
							});
							
							// Delete session keys
							redis.del(['s:'+session_data.uploadSessionId, 's:'+secret_key]);

							if (callback)
								callback(items, uid);
						});
					}
				});						
			} else
				showStatus(res, 404);
		});
	}

	self.recycle = function (secret_key, callback) {
		redis.hgetall('s:'+secret_key, function (err, session_data) {
			if (!err && session_data.recycleSessionId) {
				getItemDataFromSession(session_data.recycleSessionId, function (items) {
					redis.get('e:'+session_data.email, function (err, uid) {
						items.forEach(function (item) {
							if (uid == item.uid) {
								generateWords(item.info, function(word) {
									redis.srem('d:'+word, item.id);
								});
								
								redis.del('i:'+item.id);
								
								redis.srem('d:u:'+uid, item.id);
							}

							// Decr Count and add to items "list"
							redis.decr('count:items', function (err, count) {
								redis.zrem('items', item.id);
							});
						});

						redis.del(['s:'+session_data.recycleSessionId, 's:'+secret_key]);

						if (callback)
							callback(items);
					});
				});
			} else
				showStatus(res, 404);
		});
	}

	self.bulk_approve = function (secret_key, callback) {
		redis.hgetall('s:'+secret_key, function (err, secdata) {
			if (secdata.uploadSessionSecret)
				upload(secdata.uploadSessionSecret);
			if (secdata.recycleSessionSecret)
				recycle(secdata.recycleSessionSecret);

			callback();
		});
	}
	
	self.edit_info = function (secret_key) {
		redis.hgetall('s:'+secret_key, function (err, session_data) {
			if (!err) {
				var r = redis.multi();
				r.hmset('u:'+session_data.uid, {
					title: session_data.title.replace(/[<>]/g, ''),
					info: session_data.info.replace(/[<>]/g, '')
				});
				r.del('s:'+secret_key);
				r.exec();

				showStatus(res, 302, { Location: '/u/'+session_data.uid });
			} else
				showStatus(res, 404);
		});
	}
}

function clone(req, res) {
	if (req.method == 'GET') {
		var
		q = url.parse(req.url, true).query;

		if (q.item_id) {
			var uploadSessionId = getCookies(req).uploadSessionId || '';

			redis.hgetall('i:'+q.item_id, function(err, item_data) {
				renderHtml(res, 'clone.html', {
					uploadSessionId: uploadSessionId,
					item_info: item_data.info,
					image_id: item_data.image_id,
				});
			});
		} else
			showStatus(res, 404);
	} else
		showStatus(res, 405);
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
				// if conf.limit_before_upload has been set check if the asker has
				// uploaded any items.
				if (conf.limit_before_contact) {
					redis.get('e:'+f.email, function (err, asker_uid) {
						if (asker_uid) {
							redis.scard('d:u:'+asker_uid, function (err, num_items) {
								if (num_items >= conf.limit_before_contact)
									send_message(asker_uid);
								else
									deny_contact();
							});
						} else
							deny_contact();
					});
				} else
					send_message();

				function deny_contact () {
					renderHtml(res, 'deny_contact.html', {
						limit_before_contact: conf.limit_before_contact
					});
				}

				function send_message (asker_uid) {
					var asker_link = '';
					if (asker_uid)
						asker_link = msg.email_owner.asker+'<a href="http://'+conf.host+'/u/'+asker_uid+'">http://'+conf.host+'/u/'+asker_uid+'</a>';
					
					redis.hget('u:'+f.uid, 'email', function (err, owner_email) {
						if (email) {
							var headers = {
								from: f.email,
								to: owner_email,
								subject: msg.email_owner.subject+f.subject.replace(/[\r\n]/g, ''),
								body: f.message+msg.email_owner.body+'http://'+conf.host+'/'+f.item_id+asker_link
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
				}
			} else
				showStatus(res, 302, { Location: req.headers.referer });
		});
	} else
		showStatus(res, 405);
}

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


function go_flattr (req, res) {
	var
	code = url.parse(req.url, true).query.code,
	uploadSessionId = getCookies(req).uploadSessionId;

	// WARNING: do not commit for live app.
	var app = {
		client_id: 'w0HQL9L9mcAG4Ye7FzN44L7MnsiPJ9150yMCynBKq2gkRlimKVhFxeiLxqq6qh2g',
		client_secret: 'GEI4SaE82LjKWrWxd42A9acwqstGzmN6Rm0zmvyf7IQUZCh3w9tw9vSqObXeoAa5',
		redirect_uri: 'http://localhost:8080/flattr'
	}
	
	if (uploadSessionId) {
		flattr.request_token(app, code, function (token) {
			flattr.users.get_auth(token, function (user_data) {

				console.log(user_data);

				var
				r = redis.multi(),
				secret_key = Math.uuid(16);

				r.hmset('s:'+secret_key, {
					'uploadSessionId': uploadSessionId,
					'email': user_data.email
				});
				r.expire('s:'+secret_key, conf.ttl);
				r.exec(function () {
					var approve = new Approve();

					approve.upload(secret_key, function (items, uid) {
						renderHtml(res, 'upload_approved.html', {
							items: items,
							count: items.length,
							uid: uid 
						});
					});
				});			
			});
		});
	}
}

function createKey (size, toLower, callback) {

	var key = Math.uuid(size);

	key = toLower ? key.toLowerCase() : key;
	
	// For keys with characters < stars in the universe
	// it's a good idea to check for collisions.
	redis.exists('i:'+key, function (err, exists) {
		if (exists) {
			console.log('key collision: '+key);
			createKey(size, toLower);
		}
		else
			callback(key);
	});
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

function getItemDataFromIds(item_ids, callback) {
	var items = [];
	
	asyncLoop(item_ids.length, function(loop) {
		var item_id = item_ids[loop.iteration()];
		redis.hgetall('i:'+item_id, function (err, item_data) {
			items.push({
				uid: item_data.uid,
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
	//
	// If you change this regexp, you also need to change the one in search().
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

function setCookie(name, value, ttl) {
	var cookie = name+'='+value+';';
	
	if (ttl)
		cookie += ' Max-Age='+ttl;
	if (ttl == -1)
		cookie += ' expires=Thu, 01-Jan-1970 00:00:01 GMT;';

	return cookie;
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

