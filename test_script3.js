const fs = require('fs');
const html = fs.readFileSync('static/index.html', 'utf8');
const { JSDOM } = require('jsdom');
const dom = new JSDOM(html);
const document = dom.window.document;

// Simulate initForms
const template = document.getElementById('task-form-template');
const editContainer = document.getElementById('edit-form-container');
editContainer.appendChild(template.content.cloneNode(true));

// Simulate openEditModal for ID 430
const item = {
    id: 430,
    prompt: "A beautiful scenery",
    negative_prompt: "",
    steps: 8,
    cfg_scale: 1.0,
    width: 1024,
    height: 1024,
    loras: [],
    models: ["moody_pro_mix_v13_q8p.ckpt"],
    batch_count: 1,
    seed: -1,
    status: 'pending',
    denoising_strength: 0.7
};

document.querySelector('#edit-form-container .input-prompt').value = item.prompt;
document.querySelector('#edit-form-container .input-negative-prompt').value = item.negative_prompt || '';
document.querySelector('#edit-form-container .input-steps').value = item.steps || 8;
document.querySelector('#edit-form-container .input-cfg-scale').value = item.cfg_scale || 1.0;
document.querySelector('#edit-form-container .input-batch-count').value = item.batch_count || 2;
document.querySelector('#edit-form-container .input-seed').value = item.seed;

console.log("Steps HTML:", document.querySelector('#edit-form-container .input-steps').outerHTML);
console.log("Steps value:", document.querySelector('#edit-form-container .input-steps').value);

