const fs = require('fs');
const path = require('path');
const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'database.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'notices', 'manifest.json'), 'utf8'));
const normalize = name => String(name || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/([a-z])([0-9])/gi, '$1 $2')
  .replace(/([0-9])([a-z])/gi, '$1 $2')
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const compact = text => normalize(text).replace(/\s+/g, '');

const portalNotices = manifest
  .filter(entry => entry.path.toLowerCase().includes('portail'))
  .map(entry => normalize(entry.product || entry.reference || ''))
  .filter(Boolean);

const portalBrand = db.brands.find(b => b.id === 'portails');
const portalProducts = (portalBrand?.categories || []).flatMap(category =>
  category.products.map(product => ({
    name: product.name,
    reference: product.reference,
    normalized: normalize(`${product.name} ${product.reference || ''}`),
    compact: compact(`${product.name} ${product.reference || ''}`)
  }))
);

const matchesNotice = (text, product) => {
  const normalized = normalize(text);
  const compactText = compact(text);
  return (
    normalized === product.normalized ||
    normalized.includes(product.normalized) ||
    product.normalized.includes(normalized) ||
    compactText === product.compact ||
    compactText.includes(product.compact) ||
    product.compact.includes(compactText) ||
    product.normalized.split(' ').every(tok => tok && normalized.includes(tok))
  );
};

const productMatches = portalProducts.map(prod => ({
  ...prod,
  matchedNotices: portalNotices.filter(notice => matchesNotice(notice, prod))
}));

const noticeMatches = portalNotices.map(notice => ({
  notice,
  matchedProducts: portalProducts.filter(prod => matchesNotice(notice, prod)).map(p => p.normalized)
}));

console.log('PORTAL PRODUCTS', portalProducts.length);
console.log(productMatches.filter(p => !p.matchedNotices.length).length, 'unmatched portal products');
productMatches.filter(p => !p.matchedNotices.length).forEach(p => console.log('P', p.name, '|', p.reference, '->', p.normalized));
console.log('------');
console.log('PORTAL NOTICES', portalNotices.length);
console.log(noticeMatches.filter(n => !n.matchedProducts.length).length, 'unmatched portal notices');
noticeMatches.filter(n => !n.matchedProducts.length).forEach(n => console.log('N', n.notice));
