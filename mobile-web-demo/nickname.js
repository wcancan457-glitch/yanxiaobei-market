(function attachNicknameValidation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YanxiaobeiNickname = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createNicknameValidation() {
  const MIN_LENGTH = 2;
  const MAX_LENGTH = 20;
  const FORMAT_MESSAGE = '昵称需要为2-20个字符，不能包含换行或控制字符';
  const FORBIDDEN_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;

  function normalizeNickname(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function validNickname(value) {
    const source = String(value || '');
    if (FORBIDDEN_CHARACTERS.test(source)) return false;
    const nickname = normalizeNickname(source);
    const length = Array.from(nickname).length;
    return length >= MIN_LENGTH && length <= MAX_LENGTH;
  }

  return {
    MIN_LENGTH,
    MAX_LENGTH,
    FORMAT_MESSAGE,
    normalizeNickname,
    validNickname
  };
});
