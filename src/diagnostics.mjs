import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_DIAGNOSTICS_ROOT = path.join(homedir(), 'Library', 'Application Support', 'Repo Dashboard Projects');

// Logs stay on the local computer. Redact common credential formats as an
// additional precaution; arbitrary project output still needs review before sharing.
export function redactDiagnostics(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+\b/g, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, '[REDACTED AUTH]')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:access_token|token|api_key|key|password|secret)=)[^\s&#"']+/gi, '$1[REDACTED]')
    .replace(/\b((?:[A-Za-z_][A-Za-z0-9_]{0,127}(?:TOKEN|PASSWORD|SECRET|API_KEY)|TOKEN|PASSWORD|SECRET|API_KEY|_authToken|_auth)\b[ \t]*[=:][ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]');
}

export async function writeDiagnosticLog({ root = DEFAULT_DIAGNOSTICS_ROOT, fullName, kind, content }) {
  if (typeof fullName !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(fullName)
    || ['.', '..', '.git'].includes(fullName.split('/')[1].toLowerCase()) || !['git', 'install'].includes(kind)) {
    throw new Error('Invalid diagnostic log destination.');
  }
  const [owner, name] = fullName.split('/');
  root = path.resolve(root);
  const directory = path.join(root, owner);
  for (const folder of [root, directory]) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Diagnostic folders must be regular directories.');
  }
  const file = path.join(directory, `${name}.${kind}.log`);
  const info = await lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('Diagnostic destination must be a regular file.');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const redacted = redactDiagnostics(content);
  const limited = redacted.length > 2 * 1024 * 1024 ? `[Earlier output omitted]\n${redacted.slice(-2 * 1024 * 1024)}` : redacted;
  try {
    await writeFile(temporary, limited, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  return file;
}

// Return fixed explanations only, never package output or credential-bearing URLs.
export function classifyPackageFailure(error, { stage = 'install' } = {}) {
  let output = String(error.output || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  // Earlier nonfatal peer/engine warnings must not override the fatal npm error.
  const fatal = [...output.matchAll(/^npm (?:ERR!|error) code \w+/gmi)].at(-1);
  if (fatal) output = output.slice(fatal.index);
  const has = (code) => error.code === code || new RegExp(`(?:npm (?:ERR!|error) code |\\b)${code}\\b`, 'i').test(output);
  if (error.code === 'ETIMEDOUT') return { reason: 'TIMEOUT', statusCode: 504, message: 'The project command timed out. Check the connection and whether a setup script needs interactive input.' };
  if (error.code === 'OUTPUT_LIMIT') return { reason: 'OUTPUT_LIMIT', statusCode: 502, message: 'The project command produced too much output and was stopped.' };
  if (has('ENOSPC') || /no space left on device/i.test(output)) return { reason: 'DISK_FULL', statusCode: 507, message: 'The disk is full. Free space for the checkout and package-manager cache, then retry.' };
  if (has('EACCES') || has('EPERM') || /permission denied|operation not permitted/i.test(output)) return { reason: 'FILE_PERMISSIONS', statusCode: 403, message: 'The package manager cannot write to a required folder. Check the checkout and cache ownership in Terminal; avoid running the installer with sudo.' };
  if (has('EBADENGINE') || /engine[^\n]*(?:incompatible|not compatible)|unsupported node|requires node\.js/i.test(output)) return { reason: 'NODE_VERSION', statusCode: 409, message: 'The project requires a different Node.js or package-manager version. Use the version required by its README or the Required/Current lines in the log, then reopen Repo Dashboard.' };
  if (has('EBADPLATFORM') || /unsupported platform/i.test(output)) return { reason: 'PLATFORM', statusCode: 409, message: 'A required package does not support this operating system or processor. Check the project’s macOS support.' };
  if (has('ERESOLVE') && !/npm (?:ERR!|error) code (?!ERESOLVE\b)\w+/i.test(output)) return { reason: 'DEPENDENCY_CONFLICT', statusCode: 409, message: 'npm could not resolve compatible dependency versions. Review the conflicting packages in the log; automatic installation has not bypassed peer-dependency checks.' };
  if (/npm ci can only install packages when|package\.json and (?:package-lock\.json|npm-shrinkwrap\.json)[^\n]*in sync|ERR_PNPM_OUTDATED_LOCKFILE|YN0028/i.test(output)) return { reason: 'LOCKFILE_MISMATCH', statusCode: 409, message: 'The dependency lockfile does not match the project setup. Update it with the project’s required package-manager version in Terminal, review the changes, then retry.' };
  if (has('E401') || has('E403') || /unable to authenticate|incorrect or missing password/i.test(output)) return { reason: 'REGISTRY_AUTH', statusCode: 403, message: 'A package registry refused access. Configure that registry’s credentials in Terminal; the dashboard’s GitHub token is not used for package installation.' };
  if (has('ETARGET') || /no matching version found/i.test(output)) return { reason: 'PACKAGE_VERSION', statusCode: 409, message: 'A requested package version is unavailable from the configured registry. Check the dependency version and registry settings.' };
  if (has('EINTEGRITY')) return { reason: 'PACKAGE_INTEGRITY', statusCode: 502, message: 'A downloaded package failed its integrity check. Check the package-manager cache and connection before retrying.' };
  if (/unable_to_verify_leaf_signature|self_signed_cert|cert_has_expired|unable to (?:get local issuer|verify (?:the first|leaf)) certificate|certificate (?:verify|verification) failed|SSL certificate problem/i.test(output)) return { reason: 'TLS', statusCode: 502, message: 'The package registry’s secure connection could not be verified. Check the Mac’s date, proxy, and certificate settings.' };
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|E(?:SOCKET)?TIMEDOUT|network request/i.test(output)) return { reason: 'NETWORK', statusCode: 502, message: 'The package registry could not be reached reliably. Check the connection, VPN, proxy, and registry settings, then retry.' };
  return { reason: stage === 'build' ? 'BUILD_FAILED' : 'SETUP_FAILED', statusCode: 502,
    message: stage === 'build' ? 'Dependencies were installed, but the project build did not finish. Review the build error in the log.' : 'The package manager or a project setup script exited unsuccessfully. Review the final error in the log.' };
}
