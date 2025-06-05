/*! SmartUpscale by Marat Tanalin | http://tanalin.com */

const _callbacks = {
	os      : [],
	options : []
};

const _data = {};

function callEach(callbacks, data) {
	if (callbacks.length) {
		callbacks.forEach(callback => {
			callback({data: data});
		});
	}
}

function addCallback(callback, type) {
	const data = _data[type];

	if ('undefined' === typeof data) {
		_callbacks[type].push(callback);
	}
	else {
		callback({data: data});
	}
}

function handleContentMessage(request, sender, callback) {
	switch (request.message) {
		case 'getOs':
			addCallback(callback, 'os');
			break;

		case 'getOptions':
			addCallback(callback, 'options');
			break;

		case 'setOptions':
			options = request.data;
			break;

		default:
			callback({});
	}
}

browser.runtime.getPlatformInfo(data => {
	const os = data.os;
	_data.os = os;
	callEach(_callbacks.os, os);
});

browser.storage.local.get(null, options => {
	_data.options = options;
	callEach(_callbacks.options, options);
});

browser.runtime.onMessage.addListener(handleContentMessage);