import { execFileSync } from 'node:child_process';

export const DEFAULT_UPDATED_PROVIDERS_XLSX =
  '/Users/maikyon/Downloads/OPTIMAT Provider Validation.xlsx';

export const DEFAULT_UPDATED_PROVIDERS_SHEET = 'Updated providers';

export const PROVIDER_WEBSITE_UPDATED_PROVIDER_COLUMNS = [
  'Provider Name',
  'Eligibility (provider website)',
  'Service Area GeoJSON',
  'Service Area Cities (provider website)',
  'Cost (provider website)',
  'Service Area Website',
  'Booking days in-advance',
  'Notes',
  'Questions for Provider',
  'To tool developers',
  'Provider Software ',
  'Origin service area',
  'Destination service area',
];

export const LEGACY_UPDATED_PROVIDER_COLUMNS = [
  'Provider Name',
  'Eligibility (provider website)',
  'Eligibility (optimat)',
  'Service Area GeoJSON',
  'Service Area Cities (provider website)',
  'Cost (provider website)',
  'Cost (optimat)',
  'Service Area Website',
  'Notes',
  'Questions for Provider',
  'To tool developers',
  'Provider Software ',
];

export const EXPECTED_UPDATED_PROVIDER_COLUMNS = PROVIDER_WEBSITE_UPDATED_PROVIDER_COLUMNS;

function readZipEntry(xlsxPath, entryPath) {
  return execFileSync('unzip', ['-p', xlsxPath, entryPath], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function parseAttributes(fragment) {
  const attrs = {};
  const pattern = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(fragment))) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function parseSharedStrings(xml) {
  const strings = [];
  const siPattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = siPattern.exec(xml))) {
    const textParts = [];
    const tPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let textMatch;
    while ((textMatch = tPattern.exec(match[1]))) {
      textParts.push(decodeXml(textMatch[1]));
    }
    strings.push(textParts.join(''));
  }
  return strings;
}

function columnIndex(cellRef) {
  const letters = (cellRef.match(/^[A-Z]+/) || [''])[0];
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

function parseCellValue(cellXml, attrs, sharedStrings) {
  const valueMatch = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
  const inlineMatch = cellXml.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);

  if (attrs.t === 'inlineStr' && inlineMatch) {
    const textParts = [];
    const tPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let textMatch;
    while ((textMatch = tPattern.exec(inlineMatch[1]))) {
      textParts.push(decodeXml(textMatch[1]));
    }
    return textParts.join('');
  }

  if (!valueMatch) return '';

  const raw = decodeXml(valueMatch[1]);
  if (attrs.t === 's') {
    return sharedStrings[Number(raw)] ?? '';
  }
  return raw;
}

function worksheetRows(xml, sharedStrings) {
  const rows = [];
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(xml))) {
    const cells = [];
    const cellPattern = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) {
      const attrs = parseAttributes(cellMatch[1]);
      if (!attrs.r) continue;
      cells[columnIndex(attrs.r)] = cellMatch[2] === '/>'
        ? ''
        : parseCellValue(cellMatch[0], attrs, sharedStrings);
    }
    const width = cells.length;
    const row = [];
    for (let i = 0; i < width; i += 1) {
      row.push(cells[i] ?? '');
    }
    rows.push(row);
  }

  return rows;
}

function workbookSheets(xlsxPath) {
  const workbook = readZipEntry(xlsxPath, 'xl/workbook.xml');
  const rels = readZipEntry(xlsxPath, 'xl/_rels/workbook.xml.rels');

  const relById = new Map();
  const relPattern = /<Relationship\b([^>]*)\/>/g;
  let relMatch;
  while ((relMatch = relPattern.exec(rels))) {
    const attrs = parseAttributes(relMatch[1]);
    if (!attrs.Id || !attrs.Target) continue;
    relById.set(attrs.Id, attrs.Target.replace(/^\/?xl\//, ''));
  }

  const sheets = new Map();
  const sheetPattern = /<sheet\b([^>]*)\/>/g;
  let sheetMatch;
  while ((sheetMatch = sheetPattern.exec(workbook))) {
    const attrs = parseAttributes(sheetMatch[1]);
    const name = attrs.name;
    const relId = attrs['r:id'];
    if (!name || !relId || !relById.has(relId)) continue;
    sheets.set(name, `xl/${relById.get(relId)}`.replace(/\/+/g, '/'));
  }
  return sheets;
}

export function readWorksheetMatrix(xlsxPath, sheetName) {
  const sheets = workbookSheets(xlsxPath);
  const entry = sheets.get(sheetName);
  if (!entry) {
    throw new Error(`Worksheet not found: ${sheetName}`);
  }

  const sharedStrings = parseSharedStrings(readZipEntry(xlsxPath, 'xl/sharedStrings.xml'));
  const worksheetXml = readZipEntry(xlsxPath, entry);
  return worksheetRows(worksheetXml, sharedStrings);
}

export function readProviderWorkbookRows(
  xlsxPath = DEFAULT_UPDATED_PROVIDERS_XLSX,
  sheetName = DEFAULT_UPDATED_PROVIDERS_SHEET,
) {
  const matrix = readWorksheetMatrix(xlsxPath, sheetName).filter((row) =>
    row.some((value) => String(value ?? '').trim().length > 0)
  );
  if (matrix.length === 0) return [];

  const headers = matrix[0].map((value) => String(value ?? ''));
  const rows = matrix.slice(1).map((row) => {
    const record = {};
    for (let i = 0; i < headers.length; i += 1) {
      if (!headers[i]) continue;
      record[headers[i]] = String(row[i] ?? '').trim();
    }
    return record;
  });

  const requiredColumns = PROVIDER_WEBSITE_UPDATED_PROVIDER_COLUMNS.every((column) => headers.includes(column))
    ? PROVIDER_WEBSITE_UPDATED_PROVIDER_COLUMNS
    : LEGACY_UPDATED_PROVIDER_COLUMNS;

  for (const column of requiredColumns) {
    if (!headers.includes(column)) {
      throw new Error(`Workbook is missing required column: ${column}`);
    }
  }

  return rows.filter((row) => row['Provider Name']);
}
