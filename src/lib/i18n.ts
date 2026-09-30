import { useCallback, useSyncExternalStore } from 'react';

/**
 * English and Telugu, for the screens members read most: Home, its
 * Needs-attention list, the tab bar, paying, and notifications.
 *
 * Scope is deliberate. A half-translated form is worse than an English one --
 * a member who can read the label but not the error cannot finish it -- so
 * translation goes screen by screen, whole screens at a time. Everything not
 * yet translated stays English; a missing Telugu string falls back to its
 * English one rather than showing a key.
 *
 * Money is never translated: ₹ and Indian digit grouping read the same in
 * both, and a figure must look identical to the one on the receipt.
 */

export type Lang = 'en' | 'te';

const KEY = 'savingsclub_lang';
const listeners = new Set<() => void>();

function read(): Lang {
  try {
    return localStorage.getItem(KEY) === 'te' ? 'te' : 'en';
  } catch {
    return 'en';
  }
}

let current: Lang = read();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  try { localStorage.setItem(KEY, lang); } catch { /* private window: this tab only */ }
  document.documentElement.lang = lang;
  listeners.forEach((fn) => fn());
}

if (typeof document !== 'undefined') document.documentElement.lang = current;

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useLang(): [Lang, (l: Lang) => void] {
  return [useSyncExternalStore(subscribe, getLang, getLang), setLang];
}

type Vars = Record<string, string | number>;
export type T = (key: MsgKey, vars?: Vars) => string;

function fill(s: string, vars?: Vars): string {
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`)) : s;
}

export function translate(lang: Lang, key: MsgKey, vars?: Vars): string {
  return fill((lang === 'te' ? TE[key] : undefined) ?? EN[key], vars);
}

export function useT(): T {
  const [lang] = useLang();
  return useCallback((key: MsgKey, vars?: Vars) => translate(lang, key, vars), [lang]);
}

/** A calendar date in the reader's language. Local parts, never UTC. */
export function dateIn(lang: Lang, iso: string | null | undefined, withYear = false): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(lang === 'te' ? 'te-IN' : 'en-IN', {
    day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}),
  });
}

export function monthIn(lang: Lang, iso: string): string {
  const [y, m] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(lang === 'te' ? 'te-IN' : 'en-IN', { month: 'long' });
}

/* ------------------------------------------------------------ the strings */

const EN = {
  // tab bar
  'tab.home': 'Home',
  'tab.deposits': 'Deposits',
  'tab.loans': 'Loans',
  'tab.treasury': 'Treasury',
  'tab.community': 'Community',

  // Home
  'home.title': 'Overview',
  'home.sub.due': '{amount} to pay this month',
  'home.sub.late': '{amount} late',
  'home.sub.clear': '{amount} saved · nothing to pay',
  'home.account': 'Your account',
  'home.share': '{pct}% group share',
  'home.saved': 'You have saved',
  'home.saved.sub': 'total accumulated',
  'home.month': 'This month',
  'home.month.paid': 'Paid',
  'home.month.paid.sub': 'thank you',
  'home.month.waiting': 'Waiting',
  'home.month.waiting.sub': 'cashier to confirm',
  'home.month.overdue': 'overdue',
  'home.month.due': 'due {date}',
  'home.month.notopen': 'Not started',
  'home.month.notopen.sub': 'this month is not open yet',
  'home.month.none': 'Nothing due',
  'home.month.none.sub': 'you joined after this month',
  'home.loan': 'Active loan',
  'home.loan.none': 'None',
  'home.loan.repay': 'to repay',
  'home.loan.canborrow': 'can borrow up to {amount}',
  'home.pay': 'Pay {amount}',
  'home.figures.missing': 'Your figures could not be found just now — tap to refresh.',
  'home.attention': 'Needs attention',
  'home.loadfail': 'Some figures could not be loaded — {error}. Tap to try again.',
  'home.allclear': 'All caught up — nothing needs you right now.',
  'home.q.deposit': 'Deposit',
  'home.q.loan': 'Get Loan',
  'home.q.invite': 'Invite',
  'home.q.statement': 'Statement',
  'home.vault': 'Group Vault',
  'home.vault.total': 'Total pooled savings',
  'home.vault.lend': 'Can lend',
  'home.vault.onloan': 'On loan',
  'home.vault.reserve': 'Reserve',
  'home.vault.note': '{reserve} safety reserve locked.',
  'home.vault.rate': ' Group earns {rate}% monthly interest on active loans.',
  'home.statement': 'Statement →',
  'home.activity': 'Recent Activity',
  'home.activity.none': 'No activity recorded yet.',
  'home.activity.cash': 'in cash',
  'home.history': 'History',
  'home.savers': 'Member Savings',
  'home.savers.none': 'No members found.',
  'home.seeall': 'See all',
  'home.months.paid': '{n} months paid',

  // alerts: the reader's own
  'a.float': 'Too much cash in hand — deposit the extra in the bank',
  'a.my.overdue': 'Your {amount} contribution is overdue — tap to pay',
  'a.my.due': 'Pay your {amount} for {month} by {date}',
  'a.my.claim': 'Your {amount} payment is waiting for the cashier to confirm',
  'a.my.claim.rejected': 'Your {amount} payment was not confirmed: {reason}',
  'a.my.loan.behind': 'Your loan is {amount} behind — please repay',
  'a.my.loan.late': 'Your loan was due on {date} — {amount} still owed',
  'a.my.loan.next': 'Your next loan instalment is due {date}',
  'a.my.loan.req': 'Your {amount} loan request is waiting for votes — {yes} of {need} approvals so far',
  'a.my.loan.ok': 'Your {amount} loan is approved — waiting to be paid out',
  'a.my.expense': 'Your spending request "{what}" is waiting for votes — {yes} of {need} so far',
  // alerts: guarantor
  'a.guarantee.behind': '{name}\'s loan that you vouched for is {amount} behind',
  'a.guarantee.late': '{name}\'s loan that you vouched for is past its final date',
  // alerts: asked of the reader
  'a.loanvote.one': '{name}\'s {amount} loan request needs your vote',
  'a.loanvote.many': '{n} loan requests are waiting for your vote',
  'a.payout.one': 'Pay out {name}\'s approved {amount} loan',
  'a.payout.many': '{n} approved loans are waiting to be paid out',
  'a.claims.one': '{name} says they paid {amount} — check and confirm',
  'a.claims.many': '{n} payments ({amount}) are waiting for you to confirm',
  'a.overdue.behind.one': '1 loan is behind on repayments',
  'a.overdue.behind.many': '{n} loans are behind on repayments',
  'a.overdue.final.one': '1 loan is past its final date',
  'a.overdue.final.many': '{n} loans are past their final date',
  'a.overdue.mixed': '{n} loans need chasing — {behind} behind on repayments',
  'a.unreported.one': '1 cash payment was not told to the group in time',
  'a.unreported.many': '{n} cash payments were not told to the group in time',
  'a.pending.one': '1 person is waiting to be let into the group',
  'a.pending.many': '{n} people are waiting to be let into the group',
  'a.expvote.one': '"{what}" ({amount}) needs your vote',
  'a.expvote.many': '{n} spending requests are waiting for your vote',
  'a.late.one': '1 member is late with their contribution',
  'a.late.many': '{n} members are late with their contributions',
  'a.open': '{month} is not open yet — open it so payments can be recorded',
  'a.close.one': '{month} is past its grace date — close it to lock the entries',
  'a.close.many': '{n} past months are still open — close them to lock the entries',
  'a.dist.agree': 'A {amount} {kind} is waiting for you to agree it',
  'a.dist.mine': 'Your {amount} {kind} is waiting for another officer to agree it',
  'a.dist.seen': 'A {amount} {kind} has been proposed',
  'a.dist.final': 'final share-out',
  'a.dist.profit': 'profit share-out',
  'a.bank': 'Bank shows {bank} on {date}, books expect {books}',
  'a.bank.cash': ' — if cash was paid into the bank, tap to record it',
  'a.bank.less': ' — look for a withdrawal or charge not yet recorded',
  'a.nolend': 'Nothing left to lend — the rest must stay in the bank',
  'a.invite': 'Invite members to join — you need at least 2 members to assign cashier and accountant',
  'a.offices': 'Pick a cashier and an accountant — until then no money can be recorded',
  'a.setup': 'Finish setting up — check the group rules and save them',
  'a.upi': 'Add the group\'s UPI ID so members can pay from the app',

  // paying
  'pay.title': 'Pay {month}',
  'pay.owed': 'Still to pay',
  'pay.waiting': '{amount} already sent and waiting to be confirmed',
  'pay.upi': 'Pay with a UPI app',
  'pay.upi.hint': 'Opens PhonePe, Google Pay, Paytm or your bank app with the amount filled in.',
  'pay.qr': 'Or scan with another phone',
  'pay.to': 'To {name} · {vpa}',
  'pay.fee': '{deposit} deposit + {fee} late fee',
  'pay.copy': 'Copy UPI ID',
  'pay.copied': 'Copied',
  'pay.noupi': 'The group has not added a UPI ID yet. Pay by bank transfer, or ask an officer to add one in Settings.',
  'pay.done': 'I have paid',
  'pay.done.hint': 'Tell the cashier, so they can check it arrived. Until they confirm, it is not counted.',
  'pay.method': 'How did you pay?',
  'pay.method.upi': 'UPI',
  'pay.method.bank': 'Bank transfer',
  'pay.amount': 'Amount paid (₹)',
  'pay.ref': 'UPI transaction ID',
  'pay.ref.bank': 'Reference (optional)',
  'pay.ref.hint': 'The 12-digit number in your UPI app\'s payment details (UTR / UPI Ref No.)',
  'pay.date': 'Paid on',
  'pay.submit': 'Send to the cashier',
  'pay.sent': 'Sent. The cashier will confirm it once it shows in the bank.',
  'pay.nothing': 'Nothing is due for this month.',
  'pay.cash': 'Paying cash? Hand it to the cashier — they record it.',
  'pay.withdraw': 'Take back',

  // profile: language + notifications
  'prof.lang': 'Language',
  'prof.lang.sub': 'Home and payments in English or Telugu',
  'prof.notify': 'Phone notifications',
  'prof.notify.on': 'On for this device — a daily note of what is due',
  'prof.notify.off': 'Get a daily note of payments due and votes waiting',
  'prof.notify.blocked': 'Blocked in this browser\'s settings',
  'prof.notify.unsupported': 'Not supported in this browser',
  'prof.notify.ios': 'On iPhone, first add this app to your Home Screen (Share → Add to Home Screen), then open it from there.',
} as const;

export type MsgKey = keyof typeof EN;

// Telugu. Written for members, not translated word for word: short, the way a
// cashier would say it. Reviewed strings should replace these, not sit
// beside them.
const TE: Partial<Record<MsgKey, string>> = {
  'tab.home': 'హోమ్',
  'tab.deposits': 'జమలు',
  'tab.loans': 'అప్పులు',
  'tab.treasury': 'ఖజానా',
  'tab.community': 'సభ్యులు',

  'home.title': 'సారాంశం',
  'home.sub.due': 'ఈ నెల {amount} కట్టాలి',
  'home.sub.late': '{amount} ఆలస్యం',
  'home.sub.clear': '{amount} పొదుపు · కట్టాల్సింది ఏమీ లేదు',
  'home.account': 'మీ ఖాతా',
  'home.share': 'గ్రూప్‌లో మీ వాటా {pct}%',
  'home.saved': 'మీ పొదుపు',
  'home.saved.sub': 'మొత్తం జమ',
  'home.month': 'ఈ నెల',
  'home.month.paid': 'కట్టారు',
  'home.month.paid.sub': 'ధన్యవాదాలు',
  'home.month.waiting': 'వేచి ఉంది',
  'home.month.waiting.sub': 'క్యాషియర్ నిర్ధారించాలి',
  'home.month.overdue': 'గడువు దాటింది',
  'home.month.due': '{date} లోపు',
  'home.month.notopen': 'ఇంకా మొదలవలేదు',
  'home.month.notopen.sub': 'ఈ నెల ఇంకా తెరవలేదు',
  'home.month.none': 'బాకీ లేదు',
  'home.month.none.sub': 'మీరు ఈ నెల తర్వాత చేరారు',
  'home.loan': 'ప్రస్తుత అప్పు',
  'home.loan.none': 'లేదు',
  'home.loan.repay': 'తిరిగి కట్టాలి',
  'home.loan.canborrow': '{amount} వరకు అప్పు తీసుకోవచ్చు',
  'home.pay': '{amount} కట్టండి',
  'home.figures.missing': 'మీ వివరాలు ఇప్పుడు దొరకలేదు — మళ్లీ ప్రయత్నించడానికి నొక్కండి.',
  'home.attention': 'గమనించాల్సినవి',
  'home.loadfail': 'కొన్ని వివరాలు లోడ్ కాలేదు — {error}. మళ్లీ ప్రయత్నించడానికి నొక్కండి.',
  'home.allclear': 'అన్నీ సరిగా ఉన్నాయి — ఇప్పుడు మీరు చేయాల్సింది ఏమీ లేదు.',
  'home.q.deposit': 'జమ',
  'home.q.loan': 'అప్పు',
  'home.q.invite': 'ఆహ్వానం',
  'home.q.statement': 'నివేదిక',
  'home.vault': 'గ్రూప్ నిధి',
  'home.vault.total': 'మొత్తం పొదుపు',
  'home.vault.lend': 'ఇవ్వగలిగేది',
  'home.vault.onloan': 'అప్పుల్లో',
  'home.vault.reserve': 'నిల్వ',
  'home.vault.note': '{reserve} భద్రతా నిల్వగా ఉంచబడింది.',
  'home.vault.rate': ' అప్పులపై గ్రూప్‌కు నెలకు {rate}% వడ్డీ వస్తుంది.',
  'home.statement': 'నివేదిక →',
  'home.activity': 'ఇటీవలి లావాదేవీలు',
  'home.activity.none': 'ఇంకా ఏ లావాదేవీ లేదు.',
  'home.activity.cash': 'నగదుగా',
  'home.history': 'చరిత్ర',
  'home.savers': 'సభ్యుల పొదుపు',
  'home.savers.none': 'సభ్యులు లేరు.',
  'home.seeall': 'అన్నీ చూడండి',
  'home.months.paid': '{n} నెలలు కట్టారు',

  'a.float': 'చేతిలో నగదు ఎక్కువగా ఉంది — మిగతాది బ్యాంకులో జమ చేయండి',
  'a.my.overdue': 'మీ {amount} జమ గడువు దాటింది — కట్టడానికి నొక్కండి',
  'a.my.due': '{month} నెల {amount} ను {date} లోపు కట్టండి',
  'a.my.claim': 'మీరు కట్టిన {amount} ను క్యాషియర్ నిర్ధారించాలి',
  'a.my.claim.rejected': 'మీరు కట్టిన {amount} నిర్ధారించబడలేదు: {reason}',
  'a.my.loan.behind': 'మీ అప్పు {amount} వెనుకబడి ఉంది — దయచేసి కట్టండి',
  'a.my.loan.late': 'మీ అప్పు గడువు {date} — ఇంకా {amount} బాకీ',
  'a.my.loan.next': 'మీ తదుపరి అప్పు వాయిదా {date} న',
  'a.my.loan.req': 'మీ {amount} అప్పు అభ్యర్థన ఓట్ల కోసం వేచి ఉంది — {need} లో {yes} ఆమోదాలు',
  'a.my.loan.ok': 'మీ {amount} అప్పు ఆమోదించబడింది — ఇవ్వాల్సి ఉంది',
  'a.my.expense': 'మీ ఖర్చు అభ్యర్థన "{what}" ఓట్ల కోసం వేచి ఉంది — {need} లో {yes}',
  'a.guarantee.behind': 'మీరు హామీ ఇచ్చిన {name} అప్పు {amount} వెనుకబడి ఉంది',
  'a.guarantee.late': 'మీరు హామీ ఇచ్చిన {name} అప్పు చివరి గడువు దాటింది',
  'a.loanvote.one': '{name} యొక్క {amount} అప్పు అభ్యర్థనకు మీ ఓటు కావాలి',
  'a.loanvote.many': '{n} అప్పు అభ్యర్థనలు మీ ఓటు కోసం వేచి ఉన్నాయి',
  'a.payout.one': '{name} కు ఆమోదించిన {amount} అప్పు ఇవ్వండి',
  'a.payout.many': 'ఆమోదించిన {n} అప్పులు ఇవ్వాల్సి ఉంది',
  'a.claims.one': '{name} {amount} కట్టానని చెప్పారు — చూసి నిర్ధారించండి',
  'a.claims.many': '{n} చెల్లింపులు ({amount}) మీ నిర్ధారణ కోసం వేచి ఉన్నాయి',
  'a.overdue.behind.one': '1 అప్పు వాయిదాలలో వెనుకబడి ఉంది',
  'a.overdue.behind.many': '{n} అప్పులు వాయిదాలలో వెనుకబడి ఉన్నాయి',
  'a.overdue.final.one': '1 అప్పు చివరి గడువు దాటింది',
  'a.overdue.final.many': '{n} అప్పులు చివరి గడువు దాటాయి',
  'a.overdue.mixed': '{n} అప్పులు వసూలు చేయాలి — {behind} వాయిదాలలో వెనుకబడ్డాయి',
  'a.unreported.one': '1 నగదు లావాదేవీ సమయానికి గ్రూప్‌కు తెలపలేదు',
  'a.unreported.many': '{n} నగదు లావాదేవీలు సమయానికి గ్రూప్‌కు తెలపలేదు',
  'a.pending.one': '1 వ్యక్తి గ్రూప్‌లో చేరడానికి వేచి ఉన్నారు',
  'a.pending.many': '{n} మంది గ్రూప్‌లో చేరడానికి వేచి ఉన్నారు',
  'a.expvote.one': '"{what}" ({amount}) కు మీ ఓటు కావాలి',
  'a.expvote.many': '{n} ఖర్చు అభ్యర్థనలు మీ ఓటు కోసం వేచి ఉన్నాయి',
  'a.late.one': '1 సభ్యుడు జమ కట్టడంలో ఆలస్యం',
  'a.late.many': '{n} మంది సభ్యులు జమ కట్టడంలో ఆలస్యం',
  'a.open': '{month} ఇంకా తెరవలేదు — జమలు నమోదు చేయడానికి తెరవండి',
  'a.close.one': '{month} గడువు దాటింది — నమోదులను లాక్ చేయడానికి మూసివేయండి',
  'a.close.many': 'గత {n} నెలలు ఇంకా తెరిచే ఉన్నాయి — లాక్ చేయడానికి మూసివేయండి',
  'a.dist.agree': '{amount} {kind} మీ అంగీకారం కోసం వేచి ఉంది',
  'a.dist.mine': 'మీ {amount} {kind} మరో అధికారి అంగీకారం కోసం వేచి ఉంది',
  'a.dist.seen': '{amount} {kind} ప్రతిపాదించబడింది',
  'a.dist.final': 'చివరి పంపిణీ',
  'a.dist.profit': 'లాభ పంపిణీ',
  'a.bank': '{date} న బ్యాంకులో {bank} ఉంది, లెక్కల ప్రకారం {books} ఉండాలి',
  'a.bank.cash': ' — నగదు బ్యాంకులో జమ చేసి ఉంటే, నమోదు చేయడానికి నొక్కండి',
  'a.bank.less': ' — నమోదు చేయని విత్‌డ్రా లేదా ఛార్జీ ఉందేమో చూడండి',
  'a.nolend': 'ఇవ్వడానికి ఇంకేమీ మిగలలేదు — మిగతాది బ్యాంకులోనే ఉండాలి',
  'a.invite': 'సభ్యులను ఆహ్వానించండి — క్యాషియర్, అకౌంటెంట్ కోసం కనీసం 2 సభ్యులు కావాలి',
  'a.offices': 'క్యాషియర్, అకౌంటెంట్‌ను ఎంచుకోండి — అప్పటి వరకు ఏ డబ్బూ నమోదు చేయలేరు',
  'a.setup': 'సెటప్ పూర్తి చేయండి — గ్రూప్ నియమాలు చూసి సేవ్ చేయండి',
  'a.upi': 'సభ్యులు యాప్ నుండే కట్టడానికి గ్రూప్ UPI ID ని జోడించండి',

  'pay.title': '{month} కట్టండి',
  'pay.owed': 'ఇంకా కట్టాల్సింది',
  'pay.waiting': '{amount} ఇప్పటికే పంపారు, నిర్ధారణ కోసం వేచి ఉంది',
  'pay.upi': 'UPI యాప్‌తో కట్టండి',
  'pay.upi.hint': 'మొత్తం నింపి PhonePe, Google Pay, Paytm లేదా మీ బ్యాంక్ యాప్ తెరుచుకుంటుంది.',
  'pay.qr': 'లేదా మరో ఫోన్‌తో స్కాన్ చేయండి',
  'pay.to': '{name} కు · {vpa}',
  'pay.fee': '{deposit} జమ + {fee} ఆలస్య రుసుము',
  'pay.copy': 'UPI ID కాపీ',
  'pay.copied': 'కాపీ అయింది',
  'pay.noupi': 'గ్రూప్ ఇంకా UPI ID జోడించలేదు. బ్యాంక్ ట్రాన్స్‌ఫర్ చేయండి, లేదా సెట్టింగ్స్‌లో జోడించమని అధికారిని అడగండి.',
  'pay.done': 'నేను కట్టాను',
  'pay.done.hint': 'డబ్బు వచ్చిందో లేదో చూడటానికి క్యాషియర్‌కు తెలపండి. వారు నిర్ధారించే వరకు ఇది లెక్కలోకి రాదు.',
  'pay.method': 'ఎలా కట్టారు?',
  'pay.method.upi': 'UPI',
  'pay.method.bank': 'బ్యాంక్ ట్రాన్స్‌ఫర్',
  'pay.amount': 'కట్టిన మొత్తం (₹)',
  'pay.ref': 'UPI లావాదేవీ ID',
  'pay.ref.bank': 'రిఫరెన్స్ (ఐచ్ఛికం)',
  'pay.ref.hint': 'మీ UPI యాప్‌లోని చెల్లింపు వివరాల్లో ఉండే 12 అంకెల నంబర్ (UTR / UPI Ref No.)',
  'pay.date': 'కట్టిన తేదీ',
  'pay.submit': 'క్యాషియర్‌కు పంపండి',
  'pay.sent': 'పంపాం. బ్యాంకులో కనిపించగానే క్యాషియర్ నిర్ధారిస్తారు.',
  'pay.nothing': 'ఈ నెలకు బాకీ ఏమీ లేదు.',
  'pay.cash': 'నగదుగా కడుతున్నారా? క్యాషియర్‌కు ఇవ్వండి — వారు నమోదు చేస్తారు.',
  'pay.withdraw': 'వెనక్కి తీసుకోండి',

  'prof.lang': 'భాష',
  'prof.lang.sub': 'హోమ్, చెల్లింపులు ఇంగ్లీష్ లేదా తెలుగులో',
  'prof.notify': 'ఫోన్ నోటిఫికేషన్లు',
  'prof.notify.on': 'ఈ ఫోన్‌లో ఆన్ — బాకీల గురించి రోజూ ఒక సందేశం',
  'prof.notify.off': 'బాకీలు, ఓట్ల గురించి రోజూ ఒక సందేశం పొందండి',
  'prof.notify.blocked': 'ఈ బ్రౌజర్ సెట్టింగ్స్‌లో నిరోధించబడింది',
  'prof.notify.unsupported': 'ఈ బ్రౌజర్‌లో అందుబాటులో లేదు',
  'prof.notify.ios': 'ఐఫోన్‌లో ముందు ఈ యాప్‌ను హోమ్ స్క్రీన్‌కు జోడించండి (Share → Add to Home Screen), తర్వాత అక్కడి నుండి తెరవండి.',
};
