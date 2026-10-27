import { parseDocument } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';

// This entry is bundled for a real browser; the application is not imported.
const doc = parseDocument('# retained\nvalue: 1\n');
doc.set('value', 2);
const validate = new Ajv2020().compile({ type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] });
if (!doc.toString().includes('# retained') || !validate(doc.toJS()) || doc.get('value') !== 2) throw new Error('Browser probe failed');
document.body.textContent = 'YAML Document + AJV browser probe passed';
