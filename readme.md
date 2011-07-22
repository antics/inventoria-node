inventoria-node
===============

inventoria-node is a community driven inventory system built with NodeJS and RedisDB. It allows it's users to distribute, trade and share items and services.


Installing
------------

Install:

* NodeJS
* NPM
* RedisDB
* Imagemagick

Install modules:

* formidable
* imagemagick
* node_redis
* bind-js
* emailjs

Create uploads dir:

    mkdir static/uploads

Run:

    node server.js

Config options
--------------

**config.js** is the configuration file used for system options and localisation of server side messages.

    var config = {
    	// production || dev. dev inactivates mailings
    	mode: 'dev'/*production'*/,
    	host: 'localhost:8080',
    	// Default time to live for approval mails and sessions
    	ttl: 60*60*24,
    	// Directories
    	templates: './templates',
    	// emailjs config: github.com/eleith/emailjs
    	email: {
    		options: {
    			user: 'robot@inventoria.se',
    			password: '',
    			host: '',
    			ssl: true
    		},
    		headers: {
    			from: 'Inventoria <robot@inventoria.se>',
    			to: '',
    			subject: 'Mail från Inventoria',
    			text: ''
    		}
    	},
    	validate: {
    		email: /^([a-zA-Z0-9_\.\-\+])+\@(([a-zA-Z0-9\-])+\.)+([a-zA-Z0-9]{2,4})+$/
    	}
    }

License
-------

Copyright (C) 2011 by Humanity

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.