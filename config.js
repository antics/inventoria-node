var config = {
	// production || dev. dev inactivates mailings
	mode: 'dev'/*production'*/,
	host: 'localhost:8080',
	// Default time to live for approval mails and sessions
	ttl: 60*60*24,
	templates: './templates',
	// emailjs config: github.com/eleith/emailjs
	email: {
		options: {
			user: 'robot@inventoria.se',
			password: '',
			host: 'smtp.gmail.com',
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

var messages = {
	approve: {
		subject: 'Du har föremål att godkänna.',
		body: 'Klicka på länken för att godkänna dina sparade föremål: '
	},
	recycle: {
		subject: 'Du har föremål att återvinna.',
		body: 'Klicka på länken för att återvinna dina föremål: '
	},
	email_owner: {
		subject: 'Inventoria, ang: ',
		body: '\n\nLänk till annons: '
	},
	edit_info: {
		subject: 'Godkänn din info',
		body: 'Klicka på länken för att godkänna din ändring: '
	}
}

exports.getConfig = function () {
	return config;
};

exports.getMessages = function () {
	return messages;
};
