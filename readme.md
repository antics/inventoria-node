inventoria-node
===============

inventoria-node is a community driven inventory system built with NodeJS and RedisDB. It allows it's users to distribute, trade and share items and services.


Installing
------------

Install:

* NodeJS
* NPM
* RedisDB

Install modules:

* formidable
* imagemagick
* node_redis
* bind-js
* emailjs

Create uploads dir:

    mkdir static/uploads

Run

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