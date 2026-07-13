const fs = require('fs');
const html = fs.readFileSync('static/index.html', 'utf8');
const { JSDOM } = require('jsdom');
const dom = new JSDOM(html);
const document = dom.window.document;

// Simulate initForms
const template = document.getElementById('task-form-template');
const editContainer = document.getElementById('edit-form-container');
editContainer.appendChild(template.content.cloneNode(true));

// Simulate openEditModal
const item = {
    id: 1,
    prompt: "A beautiful scenery",
    negative_prompt: "bad",
    steps: 25,
    cfg_scale: 7.5,
    batch_count: 5,
    seed: 12345,
    loras: [],
    models: ["model1.safetensors"]
};

document.querySelector('#edit-form-container .input-prompt').value = item.prompt;
document.querySelector('#edit-form-container .input-negative-prompt').value = item.negative_prompt || '';
document.querySelector('#edit-form-container .input-steps').value = item.steps || 8;
document.querySelector('#edit-form-container .input-cfg-scale').value = item.cfg_scale || 1.0;
document.querySelector('#edit-form-container .input-batch-count').value = item.batch_count || 2;
document.querySelector('#edit-form-container .input-seed').value = item.seed;

console.log("Prompt:", document.querySelector('#edit-form-container .input-prompt').value);
console.log("Steps:", document.querySelector('#edit-form-container .input-steps').value);
console.log("CFG:", document.querySelector('#edit-form-container .input-cfg-scale').value);
