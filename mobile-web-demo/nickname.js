(function attachNicknameValidation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YanxiaobeiNickname = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createNicknameValidation() {
  const MIN_LENGTH = 2;
  const MAX_LENGTH = 20;
  const FORMAT_MESSAGE = '昵称需要为2-20个字符，不能包含换行、控制字符或平台保留称呼';
  const FORBIDDEN_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;
  const SYSTEM_NICKNAME = /^(?:同学\d{4}|昵称待设置)$/;
  const RESERVED_IDENTITY = /(燕小北.*(?:官方|客服|管理员)|平台.*(?:官方|客服|管理员)|官方|客服|管理员|系统通知)/i;

  function normalizeNickname(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function validNickname(value) {
    const source = String(value || '');
    if (FORBIDDEN_CHARACTERS.test(source)) return false;
    const nickname = normalizeNickname(source);
    const length = Array.from(nickname).length;
    return length >= MIN_LENGTH && length <= MAX_LENGTH &&
      !SYSTEM_NICKNAME.test(nickname) && !RESERVED_IDENTITY.test(nickname);
  }

  function systemNickname() {
    return '昵称待设置';
  }

  return {
    MIN_LENGTH,
    MAX_LENGTH,
    FORMAT_MESSAGE,
    normalizeNickname,
    validNickname,
    systemNickname
  };
});
