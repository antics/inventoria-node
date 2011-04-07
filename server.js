var sys = require("sys"),
http = require("http"),
url = require("url"),
path = require("path"),
fs = require("fs"),
formidable = require("formidable"),
im = require('imagemagick'),
uuid = require('./uuid'),
redis = require('redis').createClient(),
bind = require('bind');

http.createServer(function(req, res) {
	var uri = url.parse(req.url).pathname;

	switch (uri) {
	case '/':
		var query = url.parse(req.url, true).query;

		if (query && query.q)
			search(req, res, query.q);
		else
			renderHtml(res, './templates/index.html');
		break;
	case '/upload':
		upload(req, res);
		break;
	default:
		// Test for static files
		//
		var patt = /assets/i;
		if(patt.test(uri))
		{
			var filename = path.join(process.cwd(), uri);

			path.exists(filename, function(exists) {
				if(!exists) {
					res.writeHead(404, {"Content-Type": "text/plain"});
					res.end("404 Not Found\n");
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
					renderHtml(res, './templates/item.html', {key: item_id, info: nl2br(results)});
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

function search(req, res, query) {
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
							  info: item_info
						  });
						  loop.next();
					  });
				  },
				  function() {
					  renderHtml(res, './templates/index.html', output);
				  });
	});	
}

function upload(req, res) {
	// Set upload session id to retrieve recently uploaded items.
	var
	upload_session_id = getCookies(req).uploadSessionId,
	upload_session_expires = 3600;
	
	if (!upload_session_id)
		upload_session_id = Math.uuid(12);
	
	(function (callback) {
		if (req.method == 'POST') {
			var form = new formidable.IncomingForm();

			form.parse(req, function(err, fields, files) {
				var key = Math.uuid(6);

				// Check for name=image
				if (files.image && files.image != '') {
					// Resize Image
					im.resize({
						srcPath: files.image.path,
						dstPath: './assets/uploads/'+key+'.jpg',
						width: 640
					}, function (err) {
						// Thumbnail
						im.resize({
							srcPath: './assets/uploads/'+key+'.jpg',
							dstPath: './assets/uploads/_thb_'+key+'.jpg',
							width: 100
						}, function (err) {
							///// Add key to upload session list and let it expire.
							//
							// We put this here because saving files on disk is much
							// slower than doing Redis transactions in memory.
							// We have to wait until images are saved
							// before we can execute the callback function.
							redis.rpush(upload_session_id, key, function (err, results) {
								redis.expire(upload_session_id, upload_session_expires,
											 function (err, results) { callback() });
							});
						});
					});
				} else
					redis.rpush(upload_session_id, key, function (err, results) {
						redis.expire(upload_session_id, upload_session_expires,
									 function (err, results) { callback() });
					});
				
				// Save actual item data
				redis.hset('i:'+key, 'info', fields.info);

				///// Add item id (key) to word sets
				//
				// This might be an ugly hack. Find a better wat to eliminate
				// whitespaces, line return etc. without adding empty strings
				// to the words_arr. However, only if there's speed or memory gains.
				var words = fields.info.replace(/[^\wåäöÅÄÖ\s]/g, '');
				words = words.replace(/[\s]/g, ',')
				var words_arr = words.split(',');
				console.log('Array with words: '+words_arr);
				
				for (x in words_arr) {
					// See ugly hack note above
					if (words_arr[x] != '') {
						console.log('Adding word to dictionary: '+words_arr[x]);
						redis.sadd(words_arr[x].toLowerCase(), key);
					}
				}

				console.log('Item Key: '+key+'\nInfo: '+fields.info+'\nSession ID: '+
							upload_session_id+'\n');

			});
		} else callback();
	})(function () {
		var output = { items: [] };
		redis.lrange(upload_session_id, 0, -1, function (err, results) {
			results.forEach(function (val) {
				redis.hget('i:'+val, 'info', function (err, info) {
					output.items.push({
						key: val,
						info: info
					});
				});
			});
			bind.toFile('./templates/upload.html', output, function callback(data) {
				res.writeHead(200, {
					'Set-Cookie': 'uploadSessionId='+
						upload_session_id+'; Max-Age='+
						upload_session_expires,
					'Content-Type': 'text/html'
				});
				res.end(data);
			});
		});
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
	bind.toFile(file, json, function callback(data) {
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

