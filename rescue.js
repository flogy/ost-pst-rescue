#!/usr/bin/env node
// OST & PST Rescue – command line entry point.
//   node rescue.js view   <file.ost|pst> [output folder] [options]   browse the mailbox in an HTML viewer
//   node rescue.js export <file.ost|pst> [output] [options]          mail -> mbox, calendar/tasks -> .ics, contacts -> .vcf
//   node rescue.js dates  <file.ost|pst> [options]                   mails per month (are old mails missing?)
'use strict';
const { UserError } = require('./lib/mailbox');

const COMMON = {
  '--force': { key: 'force', type: 'flag', help: 'overwrite existing output' },
  '--cache-mb': { key: 'cacheMb', type: 'number', default: 64, help: 'read cache size in MB (default 64)' },
};

const COMMANDS = {
  view: {
    usage: 'view <file.ost|pst> [output folder] [options]',
    title: 'browse mail, calendar, contacts and tasks in an HTML viewer',
    summary: 'Build a read-only HTML viewer: mail, calendar, contacts and tasks. Default output: <file>_html/',
    options: {
      '--no-attachments': { key: 'attachments', type: 'flag', value: false, default: true, help: 'list attachments by name only (much smaller output)' },
      '--max-inline-kb': { key: 'maxInlineKb', type: 'number', default: 3072, help: 'largest inline image embedded in a message (default 3072)' },
      '--max-body-kb': { key: 'maxBodyKb', type: 'number', default: 2048, help: 'longer message bodies are truncated (default 2048)' },
      '--list-chunk': { key: 'listChunk', type: 'number', default: 500, help: 'message list entries per data file (default 500)' },
      '--body-chunk-kb': { key: 'bodyChunkKb', type: 'number', default: 1024, help: 'size of the message body data files (default 1024)' },
      ...COMMON,
    },
    run: (o) => require('./lib/view').buildViewer(o),
  },
  export: {
    usage: 'export <file.ost|pst> [output] [options]',
    title: 'export to mbox, iCalendar (.ics) and vCard (.vcf)',
    summary: 'Export mail to mbox, appointments and tasks to iCalendar (.ics), contacts to vCard (.vcf).\n' +
      'Default output: one .mbox per folder in <file>_mbox/ (or <file>.mbox with --single), plus\n' +
      'calendar.ics, tasks.ics and contacts.vcf next to it when the mailbox contains such items.',
    options: {
      '--list': { key: 'list', type: 'flag', help: 'only show the folder tree with item counts' },
      '--single': { key: 'single', type: 'flag', help: 'one mbox file (with an X-Folder header) instead of one per folder' },
      '--gmail-labels': { key: 'gmailLabels', type: 'flag', help: 'add the folder path as X-Gmail-Labels header (importers recreate the folders)' },
      '--include': { key: 'include', type: 'list', help: 'only folders matching this pattern (repeatable), e.g. "Inbox/Projects/**"' },
      '--exclude': { key: 'exclude', type: 'list', help: 'skip folders matching this pattern (repeatable), e.g. "Deleted Items/**"' },
      '--label-strip': { key: 'labelStrip', type: 'string', default: '', help: 'remove this leading path from labels, e.g. "Inbox"' },
      '--label-prefix': { key: 'labelPrefix', type: 'string', default: '', help: 'put all labels below this path, e.g. "Import/Outlook"' },
      '--label-slash': { key: 'labelSlash', type: 'string', default: '-', help: 'replacement for "/" inside folder names (default "-")' },
      '--mail-only': { key: 'mailOnly', type: 'flag', help: 'do not write calendar, task and contact files' },
      '--all-items': { key: 'allItems', type: 'flag', help: 'also put appointments, contacts, ... into the mbox (as text)' },
      '--no-attachments': { key: 'attachments', type: 'flag', value: false, default: true, help: 'leave out attachment content' },
      ...COMMON,
    },
    notes: 'Folder patterns: * = any characters within one level, ** = any levels, X/** = X and all subfolders,\n' +
      '? = one character, [a-c] / [!a-c] = character class. Matching is case-insensitive.',
    run: (o) => (o.list ? require('./lib/export').listFolders(o) : require('./lib/export').exportMailbox(o)),
  },
  dates: {
    usage: 'dates <file.ost|pst> [options]',
    title: 'mails per month – are old mails missing?',
    summary: 'Show how many mails exist per month (only dates are read). An abrupt start about a year ago\n' +
      'means Outlook kept only recent mail offline.',
    options: {
      '--folders': { key: 'folders', type: 'flag', help: 'also show oldest/newest date and count per folder' },
      '--cache-mb': { ...COMMON['--cache-mb'], default: 256 },
    },
    run: (o) => require('./lib/dates').mailDates(o),
  },
};

function help(name) {
  if (!name) {
    console.log('OST & PST Rescue – look inside Outlook data files and export them to open formats.\n\nUsage:');
    for (const [n, c] of Object.entries(COMMANDS)) console.log(`  node rescue.js ${c.usage.padEnd(46)} ${c.title}`);
    console.log('\nnode rescue.js <command> --help shows the options of a command.');
    return;
  }
  const c = COMMANDS[name];
  console.log(`Usage: node rescue.js ${c.usage}\n\n${c.summary}\n\nOptions:`);
  for (const [flag, o] of Object.entries(c.options)) {
    const arg = o.type === 'flag' ? '' : o.type === 'number' ? ' N' : ' <value>';
    console.log(`  ${(flag + arg).padEnd(22)} ${o.help}`);
  }
  if (c.notes) console.log('\n' + c.notes);
}

function parse(command, argv) {
  const opts = { include: [], exclude: [] };
  for (const o of Object.values(command.options)) if ('default' in o) opts[o.key] = o.default;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    const o = command.options[a];
    if (!o) {
      if (a.startsWith('--')) throw new UserError(`Unknown option ${a}. Use --help to list the options.`);
      positional.push(a);
      continue;
    }
    if (o.type === 'flag') { opts[o.key] = 'value' in o ? o.value : true; continue; }
    if (i + 1 >= argv.length) throw new UserError(`Missing value for ${a}`);
    const v = argv[++i];
    if (o.type === 'number') {
      opts[o.key] = Number(v);
      if (!Number.isFinite(opts[o.key]) || opts[o.key] <= 0) throw new UserError(`Invalid value for ${a}: ${v}`);
    } else if (o.type === 'list') opts[o.key].push(v);
    else opts[o.key] = v;
  }
  [opts.input, opts.out] = positional;
  if (positional.length > 2) throw new UserError(`Too many arguments: ${positional.slice(2).join(' ')}`);
  return opts;
}

function main(argv) {
  const [name, ...rest] = argv;
  if (!name || name === '-h' || name === '--help' || name === 'help') return help(rest[0] in COMMANDS ? rest[0] : undefined);
  const command = COMMANDS[name];
  if (!command) throw new UserError(`Unknown command "${name}". Use one of: ${Object.keys(COMMANDS).join(', ')}.`);
  const opts = parse(command, rest);
  if (opts.help) return help(name);
  if (!opts.input) {
    help(name);
    process.exitCode = 2;
    return;
  }
  command.run(opts);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UserError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
}
