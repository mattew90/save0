/*! SmartUpscale by Marat Tanalin | http://tanalin.com */

(() => {
	let values   = {},
	    elements = {},
	    buttons  = {};

	function getGuiOptions() {
		const values = {};

		forEachOptionName(name => {
			values[name] = getGuiOption(name);
		});

		return values;
	}

	function isGuiOptionUnchanged(name) {
		return getGuiOption(name) === values[name];
	}

	function areGuiOptionsUnchanged() {
		const names = getOptionsNames();
		return names.length === names.filter(isGuiOptionUnchanged).length;
	}

	function isGuiOptionDefault(name) {
		return getGuiOption(name) === optionsDefaults[name];
	}

	function areGuiOptionsDefault() {
		const names = getOptionsNames();
		return names.length === names.filter(isGuiOptionDefault).length;
	}

	function resetGuiOption(name) {
		setGuiOption(name, optionsDefaults[name]);
	}

	function resetGuiOptions() {
		forEachOptionName(resetGuiOption);
	}

	function disableLabel(id) {
		getLabelFor(id).setAttribute('_disabled', '')
	}

	function enableLabel(id) {
		getLabelFor(id).removeAttribute('_disabled');
	}

	function enable(name) {
		elements[name].disabled = false;
		enableLabel(name);
	}

	function disable(name) {
		elements[name].disabled = true;
		disableLabel(name);
	}

	function getForm() {
		return document.forms[0];
	}

	function getLegendElement() {
		return getForm().getElementsByTagName('legend')[0];
	}

	function getOptionsElements() {
		const formElements = getForm().elements,
		      elements     = {};

		forEachOptionName(name => {
			elements[name] = formElements[name];
		});

		return elements;
	}

	function getButtons() {
		const buttons = getForm().getElementsByTagName('button');

		return {
			save  : buttons[0],
			reset : buttons[1]
		};
	}

	function getLabelFor(id) {
		return getForm().querySelector('LABEL[for="' + id + '"]');
	}

	function saveGuiOptions() {
		buttons.save.disabled = true;

		values = getGuiOptions();
		saveOptions(values);

		return false;
	}

	function restoreOptions() {
		getOptions(options => {
			forEachOptionName(name => {
				const value = getNormalizedOption(options, name);
				values[name] = value;
				setGuiOption(name, value);
			});

			updateStates();
		});
	}

	function resetOptions() {
		buttons.reset.disabled = true;

		resetGuiOptions();
		updateStates();

		return false;
	}

	function localizeElement(element, messageName) {
		element.innerHTML = getString(messageName);
	}

	function localize() {
		document.documentElement.lang = getString('locale');

		localizeElement(getLegendElement(), 'options_legend');
		localizeElement(buttons.save,       'options_save');
		localizeElement(buttons.reset,      'options_reset');

		forEachOptionName(name => {
			localizeElement(getLabelFor(name), 'options_' + name);
		});
	}

	function getMaxZoomInputValue() {
		const value = elements.maxzoom.value.trim();
		return 0 === value.length ? optionsDefaults['maxzoom'] : parseInt(value);
	}

	function getGuiOption(name) {
		let value;

		switch (name) {
			case 'maxzoom':
				value = getMaxZoomInputValue();
				break;

			case 'observe':
				value = elements.observe.checked;
				break;

			case 'global':
				value = elements.global.checked;
				break;
		}

		return value;
	}

	function setGuiOption(name, value) {
		const element = elements[name];
		element['checkbox' === element.type ? 'checked' : 'value'] = value;
	}

	function updateStates() {
		buttons.save.disabled  = areGuiOptionsUnchanged();
		buttons.reset.disabled = areGuiOptionsDefault();

		['maxzoom', 'observe'].forEach(elements.global.checked ? disable : enable);
	}

	function showForm() {
		const form = getForm();

		form.offsetWidth;
		form.setAttribute('_inited', '');
	}

	function init() {
		elements = getOptionsElements();
		buttons  = getButtons();

		getForm().onsubmit    = saveGuiOptions;
		buttons.reset.onclick = resetOptions;

		['global', 'observe'].forEach(name => {
			elements[name].onchange = updateStates;
		});

		elements.maxzoom.oninput = updateStates;

		updateStates();

		restoreOptions();
		localize();

		showForm();
	}

	document.addEventListener('DOMContentLoaded', init, {once: true});
})();