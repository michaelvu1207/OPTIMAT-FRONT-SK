// Node.js 24+. Accept a password through stdin, not command-line arguments.
import { hashPassword, validPassword } from '../infra/lambda/_shared/portal-password.ts';
let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
const password = input.replace(/\r?\n$/, '');
if (!validPassword(password)) {
  console.error('Password must contain 8–128 characters.');
  process.exitCode = 1;
} else {
  console.log(await hashPassword(password));
}
