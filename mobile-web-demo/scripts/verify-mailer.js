const mailer = require('../mailer');

async function main() {
  if (!mailer.configured) {
    console.log('SMTP verification skipped: mail service is not configured');
    return;
  }
  await mailer.verifyConnection();
  console.log('SMTP connection and authentication verified');
}

main().catch((error) => {
  console.error(`SMTP verification failed: ${error.message}`);
  process.exit(1);
});
