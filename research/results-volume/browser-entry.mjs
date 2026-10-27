import { tableFromIPC, RecordBatchReader } from 'apache-arrow';
import { parquetRead, parquetMetadata, parquetMetadataAsync } from 'hyparquet';

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}

function collector(expected, verify = false) {
  const buffer = verify ? new ArrayBuffer(expected.rows * expected.columns.length * 8) : null;
  const view = buffer && new DataView(buffer);
  let checksum = 0, values = 0, uiChecksum = 0;
  return {
    add(row, column, value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0))
        throw new Error('Expected finite numeric value, without negative zero');
      const n = value;
      const intColumns = expected.kind === 'trace' ? 6 : 2;
      if (column < intColumns && (!Number.isInteger(n) || n < -2147483648 || n > 2147483647))
        throw new Error('Expected int32 key');
      checksum += Math.round(n * 1000);
      values++;
      if (row < 30000 && ['node', 'window', 'utilization', 'queueLength'].includes(expected.columns[column])) uiChecksum += Math.round(n * 1000);
      if (view) view.setFloat64((row * expected.columns.length + column) * 8, n, true);
    },
    finish(rows) {
      if (rows !== expected.rows || values !== rows * expected.columns.length)
        throw new Error('Row/value count mismatch: ' + rows + '/' + values);
      if (checksum !== expected.checksum) throw new Error('Checksum mismatch');
      return { rows, values, checksum, uiChecksum, buffer };
    }
  };
}

function checkArrowSchema(schema, expected) {
  checkColumns(schema.fields.map(f => f.name), expected.columns);
  const intColumns = expected.kind === 'trace' ? 6 : 2;
  schema.fields.forEach((f, i) => {
    if (f.nullable || f.type.toString() !== (i < intColumns ? 'Int32' : 'Float64'))
      throw new Error('Arrow physical schema mismatch');
  });
}

function checkParquetSchema(metadata, expected) {
  const fields = metadata.schema.slice(1);
  checkColumns(fields.map(f => f.name), expected.columns);
  const intColumns = expected.kind === 'trace' ? 6 : 2;
  if (metadata.schema[0].num_children !== expected.columns.length || Number(metadata.num_rows) !== expected.rows)
    throw new Error('Parquet table metadata mismatch');
  fields.forEach((f, i) => {
    if (f.repetition_type !== 'REQUIRED' || f.type !== (i < intColumns ? 'INT32' : 'DOUBLE'))
      throw new Error('Parquet physical schema mismatch');
  });
}

function checkColumns(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Column mismatch: ' + JSON.stringify(actual));
}

async function decode(bytes, expected, verify) {
  const c = collector(expected, verify);
  let rows = 0;
  switch (expected.format) {
    case 'json':
    case 'json-gzip': {
      let data = bytes;
      if (expected.format === 'json-gzip')
        data = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const doc = JSON.parse(new TextDecoder().decode(data));
      checkColumns(doc.columns, expected.columns);
      rows = doc.rows.length;
      for (let r = 0; r < rows; r++) {
        if (doc.rows[r].length !== expected.columns.length) throw new Error('Row width mismatch');
        for (let j = 0; j < expected.columns.length; j++) c.add(r, j, doc.rows[r][j]);
      }
      break;
    }
    case 'csv': {
      const text = new TextDecoder().decode(bytes);
      let start = text.indexOf('\n') + 1;
      checkColumns(text.slice(0, start - 1).split(','), expected.columns);
      while (start < text.length) {
        const end = text.indexOf('\n', start);
        const cells = text.slice(start, end < 0 ? undefined : end).split(',');
        if (cells.length !== expected.columns.length) throw new Error('CSV width mismatch');
        for (let j = 0; j < cells.length; j++) {
          if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(cells[j]))
            throw new Error('Invalid numeric CSV token');
          c.add(rows, j, Number(cells[j]));
        }
        rows++;
        start = end < 0 ? text.length : end + 1;
      }
      break;
    }
    case 'arrow': {
      const table = tableFromIPC(new Uint8Array(bytes));
      checkArrowSchema(table.schema, expected);
      rows = table.numRows;
      let offset = 0;
      for (const batch of table.batches) {
        for (let j = 0; j < batch.numCols; j++) {
          const vector = batch.getChildAt(j);
          if (vector.nullCount !== 0) throw new Error('Unexpected Arrow null');
          const column = vector.toArray();
          for (let r = 0; r < batch.numRows; r++) c.add(offset + r, j, column[r]);
        }
        offset += batch.numRows;
      }
      break;
    }
    case 'parquet': {
      const ends = new Array(expected.columns.length).fill(0);
      const metadata = parquetMetadata(bytes);
      checkParquetSchema(metadata, expected);
      await parquetRead({
        file: bytes, metadata,
        onChunk({ columnName, columnData, rowStart, rowEnd }) {
          const j = expected.columns.indexOf(columnName);
          if (j < 0 || rowStart !== ends[j] || columnData.length !== rowEnd - rowStart)
            throw new Error('Parquet chunk sequence mismatch');
          for (let k = 0; k < columnData.length; k++) c.add(rowStart + k, j, columnData[k]);
          ends[j] = rowEnd;
        }
      });
      if (ends.some(end => end !== expected.rows)) throw new Error('Parquet column rows mismatch');
      rows = ends[0];
      break;
    }
    default: throw new Error('Unknown format ' + expected.format);
  }
  return c.finish(rows);
}

window.benchmark = async (url, expected, verify = true) => {
  const start = performance.now();
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const bytes = await response.arrayBuffer();
  const loaded = performance.now();
  if (bytes.byteLength !== expected.bytes) throw new Error('Transfer byte count mismatch');
  const result = await decode(bytes, expected, false);
  const end = performance.now();
  let canonicalSha256 = null, uiCanonicalSha256 = null;
  if (verify) {
    const checked = await decode(bytes, expected, true);
    canonicalSha256 = await sha256(checked.buffer);
    if (expected.kind !== 'trace') {
      const count = Math.min(30000, expected.rows);
      const ui = new DataView(new ArrayBuffer(count * 4 * 8));
      const full = new DataView(checked.buffer);
      for (let r = 0; r < count; r++)
        for (const [j, column] of [0, 1, 8, 9].entries())
          ui.setFloat64((r * 4 + j) * 8, full.getFloat64((r * expected.columns.length + column) * 8, true), true);
      uiCanonicalSha256 = await sha256(ui.buffer);
    }
    if (canonicalSha256 !== expected.canonicalSha256) throw new Error('Canonical SHA-256 mismatch');
  }
  return { rows: result.rows, values: result.values, checksum: result.checksum, uiChecksum: result.uiChecksum,
    canonicalSha256, uiCanonicalSha256, bytes: bytes.byteLength, fetchMs: loaded - start,
    decodeAndScanMs: end - loaded, totalMs: end - start };
};

window.streamArrow = async (url, expected, verify = false) => {
  const start = performance.now();
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const reader = await RecordBatchReader.from(response.body);
  const c = collector(expected, verify);
  let rows = 0, batches = 0, firstBatchMs = null;
  for await (const batch of reader) {
    checkArrowSchema(batch.schema, expected);
    for (let j = 0; j < batch.numCols; j++) {
      const vector = batch.getChildAt(j);
      if (vector.nullCount !== 0) throw new Error('Unexpected Arrow null');
      const col = vector.toArray();
      for (let r = 0; r < batch.numRows; r++) c.add(rows + r, j, col[r]);
    }
    rows += batch.numRows;
    batches++;
    if (firstBatchMs === null) firstBatchMs = performance.now() - start;
  }
  const result = c.finish(rows);
  const totalMs = performance.now() - start;
  const canonicalSha256 = verify ? await sha256(result.buffer) : null;
  if (verify && canonicalSha256 !== expected.canonicalSha256) throw new Error('Streaming SHA mismatch');
  return { rows, batches, firstBatchMs, totalMs, canonicalSha256 };
};

window.parquetSlice = async (url, expected, uiChecksum, expectedUiSha, verify = false) => {
  const columns = ['node', 'window', 'utilization', 'queueLength'];
  let transferredBytes = 0, requests = 0, checksum = 0, values = 0;
  const rowEnd = Math.min(30000, expected.rows);
  const ends = columns.map(() => 0);
  const canonical = verify ? new DataView(new ArrayBuffer(rowEnd * columns.length * 8)) : null;
  const start = performance.now();
  const file = { byteLength: expected.bytes, async slice(start, end = expected.bytes) {
    const response = await fetch(url, { headers: { Range: 'bytes=' + start + '-' + (end - 1) }, cache: 'no-store' });
    if (response.status !== 206) throw new Error('Range response must be 206');
    const data = await response.arrayBuffer();
    transferredBytes += data.byteLength;
    requests++;
    return data;
  }};
  const metadata = await parquetMetadataAsync(file);
  checkParquetSchema(metadata, expected);
  await parquetRead({ file, metadata, columns, rowStart: 0, rowEnd,
    onChunk({ columnName, columnData, rowStart, rowEnd: chunkEnd }) {
      const column = columns.indexOf(columnName);
      const begin = Math.max(0, rowStart), end = Math.min(rowEnd, chunkEnd);
      if (column < 0) throw new Error('Unknown range column');
      if (begin >= end) return;
      if (begin !== ends[column]) throw new Error('Range column sequence mismatch');
      for (let row = begin; row < end; row++) {
        const value = columnData[row - rowStart];
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid range value');
        checksum += Math.round(value * 1000);
        if (canonical) canonical.setFloat64((row * columns.length + column) * 8, value, true);
        values++;
      }
      ends[column] = end;
    }
  });
  if (ends.some(end => end !== rowEnd) || values !== rowEnd * columns.length || checksum !== uiChecksum) throw new Error('UI slice mismatch');
  const totalMs = performance.now() - start;
  const canonicalSha256 = verify ? await sha256(canonical.buffer) : null;
  if (verify && canonicalSha256 !== expectedUiSha) throw new Error('UI slice SHA mismatch');
  return { rows: rowEnd, columns, values, checksum, transferredBytes, requests, totalMs, canonicalSha256 };
};
