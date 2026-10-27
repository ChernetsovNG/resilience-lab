import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { isAlias, parse, parseDocument, stringify, visit } from 'yaml';

// Research data only: the envelope schemas below check the dynamic objects.
type Obj = Record<string, any>;
type Files = Record<string, Obj>;
type Format = 'json' | 'yaml';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceBytes = readFileSync(join(root, '../../examples/retry-storm.json'), 'utf8');
const original: Obj = JSON.parse(sourceBytes);
const version = 'research-1';
const checks: string[] = [];
function check(name: string, fn: () => void) { fn(); checks.push(name); }
function write(path: string, value: string) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, value);
}
function ordered(value: any): any {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])]));
  }
  if (typeof value === 'number') assert(Number.isFinite(value), 'non-finite number');
  return value;
}
const json = (value: any) => JSON.stringify(ordered(value), null, 2) + '\n';
const encode = (value: any, format: Format) => format === 'json' ? json(value) :
  stringify(ordered(value), { version: '1.2', indent: 2, lineWidth: 0, aliasDuplicateObjects: false });
function yamlDocument(text: string) {
  const doc = parseDocument(text, { version: '1.2', uniqueKeys: true });
  assert.equal(doc.errors.length, 0, doc.errors.map(e => e.message).join('\n'));
  assert.equal(doc.warnings.length, 0, 'YAML warnings are rejected');
  visit(doc, (_, node) => {
    assert(!isAlias(node), 'aliases are outside this probe profile');
    if (node && typeof node === 'object') {
      assert(!('anchor' in node && node.anchor), 'anchors are outside this probe profile');
      assert(!('tag' in node && node.tag), 'explicit tags are outside this probe profile');
    }
  });
  return doc;
}
function decode(text: string, format: Format): Obj {
  const value = format === 'json' ? JSON.parse(text) : yamlDocument(text).toJS({ maxAliasCount: 0 });
  ordered(value); // Reject non-finite values before any re-serialization.
  return value;
}
function withoutId(value: Obj): Obj {
  const { id: _, ...rest } = value;
  return structuredClone(rest);
}
function split(format: Format): Files {
  const files: Files = {};
  const variants = original.variants.map((variant: Obj) => {
    const s = variant.scenario;
    files[`models/${variant.id}.${format}`] = {
      schemaVersion: version, kind: 'model', entry: s.entry,
      serviceOrder: s.services.map((s: Obj) => s.id), linkOrder: s.links.map((l: Obj) => l.id),
      services: Object.fromEntries(s.services.map((s: Obj) => [s.id,
        s.id === 'dependency' ? { libraryRef: `../library/dependency.${format}` } : withoutId(s)])),
      links: Object.fromEntries(s.links.map((l: Obj) => [l.id, withoutId(l)])),
    };
    return { id: variant.id, label: variant.label, modelRef: `models/${variant.id}.${format}`,
      layoutRef: `layout.${format}`, workload: s.workload, degradation: s.degradation };
  });
  files[`library/dependency.${format}`] = {
    schemaVersion: version, kind: 'service-template',
    description: 'Shared dependency from the original retry-storm example.',
    service: withoutId(original.variants[0].scenario.services[2]),
  };
  files[`layout.${format}`] = { schemaVersion: version, kind: 'layout',
    positions: Object.fromEntries(original.variants[0].scenario.services.map((s: Obj, i: number) =>
      [s.id, { x: i * 260, y: 100 }])) };
  files[`experiment.${format}`] = { schemaVersion: version, kind: 'experiment',
    execution: structuredClone(original.execution), variants };
  return files;
}
function refPath(owner: string, ref: string, files: Files): string {
  assert(!ref.includes(':') && !ref.includes('#') && !ref.includes('\\') && !ref.startsWith('/'), 'local references only');
  const target = posix.normalize(posix.join(posix.dirname(owner), ref));
  assert(!target.startsWith('../'), 'reference escapes workspace');
  assert(Object.hasOwn(files, target), `missing reference: ${target}`);
  return target;
}
function service(files: Files, owner: string, value: Obj, stack: string[] = []): Obj {
  if (!value.libraryRef) return value;
  assert.deepEqual(Object.keys(value), ['libraryRef'], 'probe does not implement mask overrides');
  const target = refPath(owner, value.libraryRef, files);
  assert(!stack.includes(target), 'reference cycle');
  assert.equal(files[target].kind, 'service-template');
  return service(files, target, files[target].service, [...stack, target]);
}
function rebuild(files: Files, format: Format): Obj {
  const name = `experiment.${format}`;
  const experiment = files[name];
  return { schemaVersion: original.schemaVersion, execution: experiment.execution,
    variants: experiment.variants.map((v: Obj) => {
      const modelName = refPath(name, v.modelRef, files);
      refPath(name, v.layoutRef, files);
      const m = files[modelName];
      assert.deepEqual([...m.serviceOrder].sort(), Object.keys(m.services).sort());
      assert.deepEqual([...m.linkOrder].sort(), Object.keys(m.links).sort());
      return { id: v.id, label: v.label, scenario: { entry: m.entry,
        services: m.serviceOrder.map((id: string) => ({ id, ...service(files, modelName, m.services[id]) })),
        links: m.linkOrder.map((id: string) => ({ id, ...m.links[id] })),
        workload: v.workload, degradation: v.degradation } };
    }) };
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
const str = { type: 'string', minLength: 1 };
const num = { type: 'number' };
const integer = { type: 'integer', minimum: 0 };
const object = (properties: Obj, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const map = (value: Obj) => ({ type: 'object', additionalProperties: value });
const array = (items: Obj) => ({ type: 'array', items });
const distribution = object({ kind: { enum: ['FIXED', 'EXPONENTIAL', 'LOGNORMAL'] }, meanMs: num, stdDevMs: num }, ['kind', 'meanMs']);
const serviceValue = object({ handlers: { type: 'integer', minimum: 1 }, queueCapacity: integer,
  processing: distribution, failureRate: { type: 'number', minimum: 0, maximum: 1 } });
const serviceOrRef = { oneOf: [serviceValue, object({ libraryRef: str })] };
const link = object({ from: str, to: str, network: distribution, timeoutMs: { type: 'number', exclusiveMinimum: 0 },
  maxAttempts: { type: 'integer', minimum: 1 }, retry: object({ kind: { enum: ['NONE', 'FIXED', 'EXPONENTIAL_FULL_JITTER'] },
    baseBackoffMs: num, maxBackoffMs: num, base: num }, ['kind', 'baseBackoffMs', 'maxBackoffMs']) });
const envelope = (kind: string, fields: Obj) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...object({ schemaVersion: { const: version }, kind: { const: kind }, ...fields }),
});
// Deliberately hand-written envelope probe, separate from the Kotlin-generated schema experiment.
const schemas: Record<string, Obj> = {
  model: envelope('model', { entry: str, serviceOrder: array(str), linkOrder: array(str), services: map(serviceOrRef), links: map(link) }),
  layout: envelope('layout', { positions: map(object({ x: num, y: num })) }),
  'service-template': envelope('service-template', { description: str, service: serviceOrRef }),
  experiment: envelope('experiment', { execution: object({ replications: { type: 'integer', minimum: 1 },
    warmupMs: num, measurementMs: num, seed: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    maxRealTimeSeconds: integer }), variants: array(object({ id: str, label: str, modelRef: str, layoutRef: str,
      workload: object({ arrivalRate: num, requestDeadlineMs: num }),
      degradation: { anyOf: [{ type: 'null' }, object({ serviceId: str, startMs: num, endMs: num,
        processingMultiplier: num, failureRate: num })] } })) }),
};
const validators = Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [kind, ajv.compile(schema)]));
function validate(files: Files) {
  for (const [name, value] of Object.entries(files)) {
    const validator = validators[value.kind];
    assert(validator?.(value), `${name}: ${JSON.stringify(validator?.errors)}`);
  }
}

const temp = mkdtempSync(join(tmpdir(), 'model-format-'));
function diff(before: string, after: string, name: string): string {
  writeFileSync(join(temp, 'before'), before);
  writeFileSync(join(temp, 'after'), after);
  const result = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--', 'before', 'after'], { cwd: temp, encoding: 'utf8' });
  assert(result.status === 0 || result.status === 1, result.stderr);
  return result.stdout.replaceAll('a/before', `a/${name}`).replaceAll('b/after', `b/${name}`);
}
const diffs: Obj = {};
try {
  for (const format of ['json', 'yaml'] as const) {
    const files = split(format);
    const baseName = `models/baseline.${format}`;
    const layoutName = `layout.${format}`;
    check(`${format}: split, schema, resolve and rebuild both variants in original order`, () => {
      validate(files);
      const decoded = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, decode(encode(value, format), format)]));
      assert.deepEqual(rebuild(decoded, format), original);
      for (const [name, value] of Object.entries(files)) {
        const encoded = encode(value, format);
        assert.equal(encode(decode(encoded, format), format), encoded);
        write(`fixtures/${format}/${name}`, encoded);
      }
    });
    for (const change of ['move', 'timeout', 'add-node'] as const) {
      const edited = structuredClone(files);
      if (change === 'move') edited[layoutName].positions.middle.x += 40;
      if (change === 'timeout') edited[baseName].links['middle-to-dependency'].timeoutMs = 90;
      if (change === 'add-node') {
        edited[baseName].services.worker = structuredClone(edited[baseName].services.middle);
        edited[baseName].serviceOrder.push('worker');
        edited[baseName].links['dependency-to-worker'] = { ...structuredClone(edited[baseName].links['middle-to-dependency']), from: 'dependency', to: 'worker' };
        edited[baseName].linkOrder.push('dependency-to-worker');
        edited[layoutName].positions.worker = { x: 780, y: 100 };
      }
      validate(edited);
      const changed = Object.keys(files).filter(name => encode(files[name], format) !== encode(edited[name], format));
      assert.deepEqual(changed.sort(), (change === 'move' ? [layoutName] : change === 'timeout' ? [baseName] : [baseName, layoutName]).sort());
      let patch = '';
      for (const name of changed) {
        write(`generated/${format}/${change}/${name}`, encode(edited[name], format));
        patch += diff(encode(files[name], format), encode(edited[name], format), name);
      }
      write(`diffs/${format}-${change}.diff`, patch);
      diffs[`${format}-${change}`] = { files: changed, added: patch.split('\n').filter(s => s.startsWith('+') && !s.startsWith('+++')).length,
        removed: patch.split('\n').filter(s => s.startsWith('-') && !s.startsWith('---')).length };
    }
    check(`${format}: real git merge, independent edits and competing timeout`, () => {
      const base = files[baseName];
      const ours = structuredClone(base); ours.links['middle-to-dependency'].timeoutMs = 90;
      const theirs = structuredClone(base); theirs.services.gateway.handlers = 8;
      for (const [name, value] of Object.entries({ base, ours, theirs })) writeFileSync(join(temp, name), encode(value, format));
      const clean = spawnSync('git', ['merge-file', '-p', 'ours', 'base', 'theirs'], { cwd: temp, encoding: 'utf8' });
      assert.equal(clean.status, 0, clean.stderr);
      const merged = decode(clean.stdout, format);
      assert.equal(merged.services.gateway.handlers, 8);
      assert.equal(merged.links['middle-to-dependency'].timeoutMs, 90);
      theirs.links['middle-to-dependency'].timeoutMs = 100;
      writeFileSync(join(temp, 'theirs'), encode(theirs, format));
      const conflict = spawnSync('git', ['merge-file', '-p', 'ours', 'base', 'theirs'], { cwd: temp, encoding: 'utf8' });
      assert.equal(conflict.status, 1);
      write(`diffs/${format}-merge-conflict.json`, json({ exitCode: conflict.status, stdout: conflict.stdout }));
    });
    check(`${format}: invalid schema, missing/cyclic/outside references rejected`, () => {
      const bad = structuredClone(files); bad[baseName].unexpected = true;
      assert.throws(() => validate(bad));
      delete bad[baseName].unexpected;
      bad[baseName].links['middle-to-dependency'].timeoutMs = 'slow';
      assert.throws(() => validate(bad));
      for (const ref of ['../library/missing.' + format, '../../outside.' + format, 'https://example.invalid/x']) {
        const invalid = structuredClone(files); invalid[baseName].services.dependency.libraryRef = ref;
        assert.throws(() => rebuild(invalid, format));
      }
      const cyclic = structuredClone(files);
      cyclic[`library/dependency.${format}`].service = { libraryRef: `dependency.${format}` };
      assert.throws(() => rebuild(cyclic, format), /reference cycle/);
    });
  }
} finally { rmSync(temp, { recursive: true, force: true }); }

const commented = '# document note\ntimeoutMs: 60 # inline note\ndescription: "Human explanation"\n# trailing note\n';
check('YAML: Document edit retains all three comments; DTO rewrite loses them', () => {
  const doc = yamlDocument(commented);
  doc.setIn(['timeoutMs'], 90);
  const astText = doc.toString();
  for (const note of ['document note', 'inline note', 'trailing note']) assert(astText.includes(note));
  assert.equal(yamlDocument(astText).toString(), astText);
  const plain = parse(commented); plain.timeoutMs = 90;
  const dtoText = stringify(plain);
  assert(!dtoText.includes('inline note'));
  write('comments/original.yaml', commented);
  write('comments/ast-edit.yaml', astText);
  write('comments/dto-edit.yaml', dtoText);
});
check('strict YAML profile rejects duplicate keys, aliases, tags and non-finite numbers', () => {
  for (const text of ['x: 1\nx: 2', 'x: &a [1]\ny: *a', 'x: !!str 1', 'x: .nan', 'x: .inf']) assert.throws(() => decode(text, 'yaml'));
});
check('JSON builtin limitations and finite guard are observable', () => {
  assert.equal(JSON.parse('{"x":1,"x":2}').x, 2);
  assert.equal(JSON.parse('{"x":1e400}').x, Infinity);
  assert.throws(() => decode('{"x":1e400}', 'json'));
  assert.throws(() => decode('{/*comment*/"x":1}', 'json'));
  assert.equal(JSON.parse(json({ description: 'Human explanation' })).description, 'Human explanation');
  const unsafe = split('json'); unsafe['experiment.json'].execution.seed = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => validate(unsafe));
});
const kotlinSchema = JSON.parse(readFileSync(join(root, 'jvm/results/probe.schema.json'), 'utf8'));
const kotlinValidate = ajv.compile(kotlinSchema);
check('Kotlin-generated schema is consumed by AJV 2020 without translation', () => {
  const good = JSON.parse(readFileSync(join(root, 'jvm/results/probe-good.json'), 'utf8'));
  assert(kotlinValidate(good), JSON.stringify(kotlinValidate.errors));
  for (const file of ['probe-missing-required.json', 'probe-invalid-enum.json', 'probe-invalid-kind.json']) {
    assert(!kotlinValidate(JSON.parse(readFileSync(join(root, 'jvm/results', file), 'utf8'))), file);
  }
  const omittedNullable = JSON.parse(readFileSync(join(root, 'jvm/results/probe-explicit-nulls-false.json'), 'utf8'));
  assert(!kotlinValidate(omittedNullable));
  assert(kotlinValidate.errors?.some(error => error.keyword === 'required' && error.params.missingProperty === 'requiredNullable'));
});
for (const [kind, schema] of Object.entries(schemas)) write(`schemas/${kind}.schema.json`, json(schema));
write('results/js-checks.json', json({ sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'), checks, diffs,
  limitations: ['JSON.parse does not reject duplicate keys', 'Envelope schemas are handwritten and do not replace domain validation',
    'No compound block ports or mask overrides', 'Writer stability is checked within one library/version, not cross-language byte identity'] }));

if (process.argv.includes('--benchmark')) {
  const measurements: Obj[] = [];
  for (const blocks of [50, 500, 5000]) {
    const value = { services: Array.from({ length: blocks }, (_, i) => ({ id: `service-${i}`, handlers: 4,
      queueCapacity: 16, processing: { kind: 'FIXED', meanMs: 2 }, failureRate: 0 })) };
    const texts = { json: encode(value, 'json'), yaml: encode(value, 'yaml') };
    for (const [name, fn, format] of [
      ['JSON.parse', JSON.parse, 'json'], ['yaml.parse', parse, 'yaml'],
      ['yaml.parseDocument', parseDocument, 'yaml'],
    ] as const) {
      for (let i = 0; i < 5; i++) fn(texts[format]);
      const times: number[] = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now(); fn(texts[format]); times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      measurements.push({ blocks, parser: name, bytes: Buffer.byteLength(texts[format]), warmup: 5, iterations: 20,
        medianMs: (times[9] + times[10]) / 2, p95Ms: times[18] });
    }
  }
  write('results/js-benchmark.json', json({ runtime: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
    scope: 'Parse preloaded strings only; no I/O, schema validation, model compilation or simulation. Synthetic flat services, not hierarchy. Sequential in one Node process.', measurements }));
}
console.log(`${checks.length} checks passed; fixtures, actual git diffs and results written.`);
