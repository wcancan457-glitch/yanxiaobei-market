const IMAGE_CLASSES = new Set([
  'img-book',
  'img-phone',
  'img-lamp',
  'img-clothes',
  'img-ball',
  'img-guitar'
]);

function sanitizeProductImage(value) {
  const image = String(value || '').trim();
  if (!image) return '';
  if (image.length > 6_000_000) throw new Error('商品图片过大');
  if (!/^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/]+={0,2}$/i.test(image)) {
    throw new Error('商品图片格式不受支持');
  }
  return image;
}

function sanitizeStoredProductImage(value) {
  const image = String(value || '').trim();
  if (!image) return '';
  if (/^assets\/products\/[a-z0-9._-]+\.(?:png|jpe?g|webp)$/i.test(image)) return image;
  return sanitizeProductImage(image);
}

function sanitizeImageClass(value) {
  const imageClass = String(value || '').trim();
  if (!IMAGE_CLASSES.has(imageClass)) throw new Error('商品图片样式不合法');
  return imageClass;
}

module.exports = { IMAGE_CLASSES, sanitizeProductImage, sanitizeStoredProductImage, sanitizeImageClass };
