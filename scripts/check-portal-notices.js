const fs = require('fs');
const path = require('path');
const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'database.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'notices', 'manifest.json'), 'utf8'));
const normalizeText = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').trim();

const portalEntries = manifest.filter(entry => entry.path.toLowerCase().includes('portail'));
console.log('PORTAL MANIFEST COUNT', portalEntries.length);
portalEntries.forEach(entry => console.log(entry.path, '=>', entry.product));

const products = [];
db.brands.forEach(brand => {
  brand.categories.forEach(category => {
    category.products.forEach(product => {
      products.push({
        brand: brand.name,
        category: category.name,
        name: product.name,
        reference: product.reference,
        normalized: normalizeText(`${brand.name} ${category.name} ${product.name} ${product.reference || ''}`)
      });
    });
  });
});

const unmatched = portalEntries.filter(entry => {
  const normalizedEntry = normalizeText(entry.product || entry.reference || '');
  return !products.some(prod => prod.normalized.includes(normalizedEntry));
});
console.log('\nUNMATCHED PORTAL ENTRIES', unmatched.length);
unmatched.forEach(entry => console.log(entry.path, '=>', entry.product));

const productsWithPortalDocs = products.map(prod => {
  const matchedDocs = portalEntries.filter(entry => {
    const normalizedEntry = normalizeText(entry.product || entry.reference || '');
    return prod.normalized.includes(normalizedEntry) && !entry.path.toLowerCase().endsWith('.jpg') && !entry.path.toLowerCase().endsWith('.png') && !entry.path.toLowerCase().endsWith('.webp') && !entry.path.toLowerCase().endsWith('.svg');
  }).map(entry => entry.path);
  return { ...prod, portalDocs: matchedDocs };
}).filter(prod => prod.portalDocs.length);

console.log('\nPRODUCTS WITH PORTAL DOCS', productsWithPortalDocs.length);
productsWithPortalDocs.forEach(prod => {
  console.log(`${prod.brand} / ${prod.category} / ${prod.name} | ${prod.reference} -> ${prod.portalDocs.join(', ')}`);
});

const portalProducts = products.filter(prod =>
  prod.brand.toLowerCase() === 'portails' ||
  (prod.category.toLowerCase() === 'somfy' && /dexxo|elixo|freevia|axovia|c400|c500|sl71|ls4|go|passeo|s400|ls420|situo|smoove|telis/.test(prod.normalized))
);
console.log('\nPOTENTIAL PORTAL PRODUCTS', portalProducts.length);
portalProducts.forEach(prod => console.log(prod.brand, '/', prod.category, '/', prod.name, '|', prod.reference));
