// Reads the password from stdin, never from a command-line argument or source file.
// This utility only produces a hash; it does not create accounts or connect to a DB.
import { hashPassword, validPassword } from '../lambda/_shared/portal-password.js';
let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
const password = input.replace(/\r?\n$/, '');
if (!validPassword(password)) {
  console.error('Password must contain 8–128 characters.');
  process.exitCode = 1;
} else console.log(await hashPassword(password));
