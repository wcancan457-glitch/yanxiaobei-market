const nodemailer = require('nodemailer');

const smtpHost = String(process.env.SMTP_HOST || '').trim();
const smtpPort = Number(process.env.SMTP_PORT || 0);
const smtpUser = String(process.env.SMTP_USER || '').trim();
const smtpPass = String(process.env.SMTP_PASS || '');
const mailFrom = String(process.env.MAIL_FROM || smtpUser).trim();

const configured = Boolean(smtpHost && smtpPort && smtpUser && smtpPass && mailFrom);

let transporter = null;

function getTransporter() {
  if (!configured) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000
    });
  }
  return transporter;
}

async function sendCode({ to, purpose, code }) {
  const client = getTransporter();
  if (!client) {
    const error = new Error('邮件发送服务尚未配置');
    error.code = 'mail_not_configured';
    throw error;
  }
  const verification = purpose === 'verify_email';
  const action = verification ? '完成北工大身份认证' : '重置燕小北集市密码';
  await client.sendMail({
    from: mailFrom,
    to,
    subject: `燕小北集市：${action}`,
    text: [
      `你正在${action}。`,
      '',
      `验证码：${code}`,
      '验证码 10 分钟内有效，请勿转发给他人。',
      '',
      '如果不是你本人操作，请忽略这封邮件。'
    ].join('\n')
  });
}

async function verifyConnection() {
  const client = getTransporter();
  if (!client) {
    const error = new Error('邮件发送服务尚未配置');
    error.code = 'mail_not_configured';
    throw error;
  }
  await client.verify();
}

module.exports = { configured, sendCode, verifyConnection };
