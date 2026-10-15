import type { EmailTemplate } from '../modules/core/core.services'

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Only http(s) links reach an href. */
const safeUrl = (u: unknown) => {
  try {
    const url = new URL(String(u))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '#'
  } catch {
    return '#'
  }
}

function layout(title: string, bodyHtml: string, cta?: { label: string; url: string }) {
  const button = cta
    ? `<p style="margin:24px 0"><a href="${esc(safeUrl(cta.url))}" style="background:#466e5a;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${esc(cta.label)}</a></p>
       <p style="color:#6b7280;font-size:12px">If the button does not work, copy this link: ${esc(safeUrl(cta.url))}</p>`
    : ''
  return `<!doctype html><html><body style="margin:0;background:#f7f8f4;font-family:Inter,Segoe UI,Arial,sans-serif;color:#111827">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;padding:32px;max-width:560px">
  <tr><td><div style="font-weight:700;color:#3a6653;margin-bottom:16px">Project N</div>
  <h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${bodyHtml}${button}
  <p style="color:#9ca3af;font-size:12px;margin-top:32px">Project N Assignment Management System</p></td></tr></table></td></tr></table></body></html>`
}

const plain = (lines: string[]) => lines.filter(Boolean).join('\n\n')

export interface Rendered {
  subject: string
  html: string
  text: string
}

/** One function per message; every dynamic value is escaped. */
export function renderEmail(template: EmailTemplate, d: Record<string, unknown>): Rendered {
  const name = d.name ? String(d.name) : 'there'
  switch (template) {
    case 'verify_email':
      return {
        subject: 'Verify your e-mail address',
        html: layout('Verify your e-mail', `<p>Hi ${esc(name)}, confirm your address to finish setting up your account. The link works for 24 hours.</p>`, { label: 'Verify e-mail', url: String(d.link) }),
        text: plain([`Hi ${name},`, 'Confirm your e-mail address (valid 24 hours):', String(d.link)]),
      }
    case 'reset_password':
      return {
        subject: 'Reset your password',
        html: layout('Reset your password', `<p>Hi ${esc(name)}, we received a request to reset your password. The link works for 30 minutes. If this was not you, ignore this message.</p>`, { label: 'Choose a new password', url: String(d.link) }),
        text: plain([`Hi ${name},`, 'Reset your password (valid 30 minutes). If this was not you, ignore this message.', String(d.link)]),
      }
    case 'password_changed':
      return {
        subject: 'Your password was changed',
        html: layout('Your password was changed', `<p>Hi ${esc(name)}, your password was just changed and you were signed out everywhere. If this was not you, reset your password immediately.</p>`),
        text: plain([`Hi ${name},`, 'Your password was just changed and you were signed out everywhere. If this was not you, reset it immediately.']),
      }
    case 'account_exists':
      return {
        subject: 'You already have an account',
        html: layout('You already have an account', `<p>Hi ${esc(name)}, someone tried to sign up with this address. If it was you, simply sign in or reset your password. Nothing was changed.</p>`),
        text: plain([`Hi ${name},`, 'Someone tried to sign up with this address. If it was you, sign in or reset your password. Nothing was changed.']),
      }
    case 'account_locked':
      return {
        subject: 'Your account was temporarily locked',
        html: layout('Account temporarily locked', `<p>Hi ${esc(name)}, there were too many failed sign-in attempts, so your account is locked for 15 minutes. If this was not you, consider resetting your password.</p>`),
        text: plain([`Hi ${name},`, 'Too many failed sign-in attempts: your account is locked for 15 minutes.']),
      }
    case 'invite':
      return {
        subject: `${d.invitedBy ?? 'Someone'} invited you to ${d.workspaceName ?? 'Project N'}`,
        html: layout(`Join ${String(d.workspaceName ?? 'Project N')}`, `<p>Hi ${esc(name)}, ${esc(d.invitedBy)} invited you to join <b>${esc(d.workspaceName)}</b> as ${esc(String(d.role ?? 'member').replace('_', ' '))}. The invitation is valid for 7 days.</p>`, { label: 'Accept invitation', url: String(d.link) }),
        text: plain([`Hi ${name},`, `${d.invitedBy} invited you to join ${d.workspaceName} (valid 7 days):`, String(d.link)]),
      }
    case 'change_email':
      return {
        subject: 'Confirm your new e-mail address',
        html: layout('Confirm your new e-mail', `<p>Hi ${esc(name)}, confirm this address to use it for your account.</p>`, { label: 'Confirm', url: String(d.link) }),
        text: plain([`Hi ${name},`, 'Confirm your new e-mail address:', String(d.link)]),
      }
    case 'notification':
      return {
        subject: String(d.title ?? 'Project N update'),
        html: layout(String(d.title ?? 'Update'), `<p>${esc(d.body)}</p>`, d.link ? { label: 'Open', url: String(d.link) } : undefined),
        text: plain([String(d.title ?? ''), String(d.body ?? ''), String(d.link ?? '')]),
      }
    case 'data_export_ready':
      return {
        subject: 'Your Project N data export',
        html: layout('Your data export', `<p>Hi ${esc(name)}, your data export is attached as a JSON file.</p>`),
        text: plain([`Hi ${name},`, 'Your data export is attached as a JSON file.']),
      }
  }
}
