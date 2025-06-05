/*! SmartUpscale by Marat Tanalin | http://tanalin.com */

let browserOverridden;

if ('undefined' === typeof browser) {
	browser = chrome;
	browserOverridden = true;
}
else {
	browserOverridden = false;
}

const optionsDefaults = {
	'maxzoom' : 0,
	'observe' : true,
	'global'  : false
};

function getOptionsNames() {
	return Object.keys(optionsDefaults);
}

function forEachOptionName(callback) {
	getOptionsNames().forEach(callback);
}

function getNormalizedOption(options, name) {
	return options.hasOwnProperty(name)
	     ? options[name]
	     : optionsDefaults[name];
}

function normalizeOptions(aOptions) {
	const options = {};

	forEachOptionName(name => {
		options[name] = getNormalizedOption(aOptions, name);
	});

	return options;
}

function getOptions(callback) {
	browser.runtime.sendMessage(
		{message: 'getOptions'},
		message => {
			// Sometimes `message` is undefined for some reason.
			if ('undefined' !== typeof message) {
				callback(normalizeOptions(message.data));
			}
		}
	);
}

function saveOptions(options) {
	browser.storage.local.set(options);

	browser.runtime.sendMessage({
		message : 'setOptions',
		data    : options
	});
}

function getString(name) {
	return browser.i18n.getMessage(name);
}