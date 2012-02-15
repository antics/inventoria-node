var config = {
	// production || dev. dev inactivates mailings
	mode: 'dev'/*production'*/,
	host: 'localhost:8080',
	lang: 'sv_SE',
	
	// Default time to live for approval mails and sessions
	ttl: 60*60*24,

	// Template directorie
	templates: './templates',

	// User must have uploaded atleast 3 items before she can email
	// other users. Set to 0 for no limit.
	limit_before_contact: 3,

	// Email options and default headers
	email: {
		// emailjs config: github.com/eleith/emailjs
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
	},
	flattr: {
		app: {
			client_id: 'YmTIiuL3rDfdhiCTjRC5TaxfJgr5Kdqyqa6yuIrMcxQjFi3PZvKJv8P5f61Paher',
			client_secret: 'hbQCJ7eMvUV03PFTagswf7rl4i05q5ny630G14imP4dIJIrKPK6VHo6CxXyNSLbO',
			redirect_uri: 'http://localhost:8080/flattr'
		}
	}
}

var messages = {
	approve: {
		subject: 'Du har föremål att godkänna.',
		body: 'Klicka på länken för att godkänna dina sparade föremål: '
	},
	bulk: {
		subject: 'Du har ändringar att godkänna.',
		body: 'Klicka på länken för att godkänna dina ändringar: '
	},
	recycle: {
		subject: 'Du har föremål att återvinna.',
		body: 'Klicka på länken för att återvinna dina föremål: '
	},
	email_owner: {
		subject: 'Inventoria, ang: ',
		body: '\n\nLänk till ditt föremål: ',
		asker: '\nKontaktarens föremål: '
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
