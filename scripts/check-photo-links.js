const fs = require('fs');
const path = require('path');
const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'database.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'notices', 'manifest.json'), 'utf8'));
const normalizeText = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').trim();
const isImagePath = filePath => /\.(png|jpe?g|webp|svg)$/i.test(filePath);
const imageEntryMatchesProduct = (entryText, normalizedProduct) => {
  if (!entryText) return false;
  const brandMatch = normalizedProduct.includes('somfy') && entryText.includes('somfy');
  const ioMatch = normalizedProduct.includes('io') && entryText.includes('io');
  const rtsMatch = normalizedProduct.includes('rts') && entryText.includes('rts');
  const keypadMatch = normalizedProduct.includes('io') && entryText.includes('keypad');
  const smooveMatch = normalizedProduct.includes('io') && entryText.includes('smoove');
  const situoMatch = normalizedProduct.includes('rts') && entryText.includes('situo');
  if (brandMatch && (ioMatch || rtsMatch || keypadMatch || smooveMatch || situoMatch)) return true;
  if (ioMatch && entryText.includes('io')) return true;
  if (rtsMatch && entryText.includes('rts')) return true;
  return false;
};
const items = Array.isArray(manifest) ? manifest : [];
const productsWithPhotos = [];
for (const brand of db.brands) {
  for (const category of brand.categories) {
    for (const product of category.products) {
      const normalizedProduct = normalizeText(`${brand.name} ${category.name} ${product.name} ${product.reference || ''}`);
      const matchedPhotos = items.filter(entry => {
        if (!isImagePath(entry.path)) return false;
        const normalizedEntry = normalizeText(entry.product || entry.reference || '');
        if (!normalizedEntry) return false;
        if (normalizedProduct.includes(normalizedEntry)) return true;
        return imageEntryMatchesProduct(normalizedEntry, normalizedProduct);
      }).map(entry => entry.path);
      if (matchedPhotos.length) {
        productsWithPhotos.push({ brand: brand.name, category: category.name, product: product.name, reference: product.reference, photos: matchedPhotos });
      }
    }
  }
}
console.log(JSON.stringify(productsWithPhotos, null, 2));
