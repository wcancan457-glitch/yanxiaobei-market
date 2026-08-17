const assert = require('assert');
const { sanitizeProductImage, sanitizeStoredProductImage, sanitizeImageClass } = require('../content-security');

assert.equal(sanitizeProductImage(''), '');
assert.equal(sanitizeProductImage('data:image/png;base64,aGVsbG8='), 'data:image/png;base64,aGVsbG8=');
assert.throws(() => sanitizeProductImage('https://example.com/image.png'));
assert.throws(() => sanitizeProductImage('data:image/svg+xml;base64,PHN2Zz4='));
assert.throws(() => sanitizeProductImage('x" onerror="alert(1)'));
assert.equal(sanitizeStoredProductImage('assets/products/book.jpg'), 'assets/products/book.jpg');
assert.throws(() => sanitizeStoredProductImage('javascript:alert(1)'));
assert.equal(sanitizeImageClass('img-book'), 'img-book');
assert.throws(() => sanitizeImageClass('img-book" onmouseover="alert(1)'));

console.log('Product image security tests passed');
