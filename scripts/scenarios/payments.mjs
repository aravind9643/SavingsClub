/**
 * The UPI loop: a member pays and says so, the cashier confirms, the cash that
 * came in by hand goes to the bank -- and the daily digest tells each person
 * what is theirs to do.
 *
 * Every refusal is tested alongside the path that works, because the value of
 * a claim is that it is NOT money until someone has seen it arrive.
 */

export default {
  name: 'payments',
  describe: 'UPI details, "I have paid" claims, cash to bank, daily digest',

  async run({ club, expect, note, rupees, target }) {
    const { admin, cashier, accountant, everyone } = await club.withMembers(
      ['Anita', 'Bhaskar', 'Chandra', 'Devi'],
      { monthly: rupees(1000) },
    );
    const [, , , devi] = everyone;
    await club.openMonth(cashier);

    // --- where members pay -------------------------------------------------
    await admin.rpc('set_group_upi', { p_upi_id: 'Sangam.Fund@okicici', p_payee_name: 'Sangam Savings' });
    const [g] = await admin.read('groups');
    expect('UPI ID saved, lower-cased', g.upi_id, 'sangam.fund@okicici');
    note('refused: ' + await admin.cannot('save a malformed UPI ID', () =>
      admin.rpc('set_group_upi', { p_upi_id: 'not a vpa' })));
    note('refused: ' + await devi.cannot('set the UPI ID as a plain member', () =>
      devi.rpc('set_group_upi', { p_upi_id: 'mine@okaxis' })));

    // --- a claim is not money ----------------------------------------------
    const fundBefore = Number((await cashier.fund()).total_fund_paise);
    const claim = await devi.rpc('claim_payment', {
      p_period_id: club.periodId, p_amount_paise: rupees(1000),
      p_method: 'upi', p_reference: 'UTR426811',
    });
    expect('claim starts pending', claim.status, 'pending');
    expect('the fund does not move on a claim',
      Number((await cashier.fund()).total_fund_paise), fundBefore);
    expect('and she is still on the chase-list',
      (await cashier.unpaid()).some((u) => u.member_id === devi.memberId), true);

    note('refused: ' + await devi.cannot('claim more than is owed while a claim is pending', () =>
      devi.rpc('claim_payment', { p_period_id: club.periodId, p_amount_paise: rupees(1), p_method: 'bank' })));
    note('refused: ' + await devi.cannot('claim UPI without a transaction ID', () =>
      devi.rpc('claim_payment', { p_period_id: club.periodId, p_amount_paise: rupees(1), p_method: 'upi' })));
    note('refused: ' + await devi.cannot('claim cash', () =>
      devi.rpc('claim_payment', { p_period_id: club.periodId, p_amount_paise: rupees(1), p_method: 'cash' })));
    note('refused: ' + await everyone[0].cannot('reuse someone else\'s transaction ID', () =>
      everyone[0].rpc('claim_payment', {
        p_period_id: club.periodId, p_amount_paise: rupees(1000), p_method: 'upi', p_reference: 'utr426811',
      })));
    note('refused: ' + await admin.cannot('confirm as the admin (not a money office)', () =>
      admin.rpc('confirm_payment_claim', { p_claim_id: claim.id })));
    note('refused: ' + await everyone[0].cannot('withdraw someone else\'s claim', () =>
      everyone[0].rpc('withdraw_payment_claim', { p_claim_id: claim.id })));

    // --- confirmed: it becomes an ordinary contribution --------------------
    const done = await cashier.rpc('confirm_payment_claim', { p_claim_id: claim.id });
    expect('confirmed', done.status, 'confirmed');
    const rows = await cashier.read('contributions', { eq: { member_id: devi.memberId } });
    expect('one contribution, from the claim', rows.length, 1);
    expect('recorded as UPI', rows[0].method, 'upi');
    expect('fund grows by the payment and any late fee',
      Number((await cashier.fund()).total_fund_paise),
      fundBefore + rupees(1000) + Number(rows[0].late_fee_paise));
    expect('she is off the chase-list',
      (await cashier.unpaid()).some((u) => u.member_id === devi.memberId), false);
    expect('UPI money did not enter the cash float',
      Number((await cashier.fund()).cash_float_paise), 0);
    note('refused: ' + await accountant.cannot('confirm the same claim twice', () =>
      accountant.rpc('confirm_payment_claim', { p_claim_id: claim.id })));

    // --- a cashier's own payment needs the other money office -------------
    const own = await cashier.rpc('claim_payment', {
      p_period_id: club.periodId, p_amount_paise: rupees(1000), p_method: 'upi', p_reference: 'UTR9001',
    });
    note('refused: ' + await cashier.cannot('confirm your own payment', () =>
      cashier.rpc('confirm_payment_claim', { p_claim_id: own.id })));
    await accountant.rpc('confirm_payment_claim', { p_claim_id: own.id });

    // --- rejected, with a reason, and the member can try again ------------
    const anita = everyone[0];
    const wrong = await anita.rpc('claim_payment', {
      p_period_id: club.periodId, p_amount_paise: rupees(1000), p_method: 'upi', p_reference: 'UTR5555',
    });
    note('refused: ' + await cashier.cannot('turn a payment down without saying why', () =>
      cashier.rpc('reject_payment_claim', { p_claim_id: wrong.id, p_reason: '  ' })));
    const rej = await cashier.rpc('reject_payment_claim', { p_claim_id: wrong.id, p_reason: 'Not in the bank statement' });
    expect('rejected', rej.status, 'rejected');
    const again = await anita.rpc('claim_payment', {
      p_period_id: club.periodId, p_amount_paise: rupees(1000), p_method: 'upi', p_reference: 'UTR5555',
    });
    expect('a rejected transaction ID can be claimed again', again.status, 'pending');
    const back = await anita.rpc('withdraw_payment_claim', { p_claim_id: again.id });
    expect('and withdrawn by its owner', back.status, 'withdrawn');

    // --- cash in hand to the bank -----------------------------------------
    await cashier.takesPayment(anita, rupees(1000), { method: 'cash' });
    let fund = await cashier.fund();
    const fundNow = Number(fund.total_fund_paise);
    expect('cash payment is in hand', Number(fund.cash_float_paise) >= rupees(1000), true);
    const held = Number(fund.cash_float_paise);

    note('refused: ' + await cashier.cannot('deposit more cash than is held', () =>
      cashier.rpc('deposit_cash_to_bank', { p_amount_paise: held + 1 })));
    note('refused: ' + await accountant.cannot('deposit as the accountant (the cashier holds the cash)', () =>
      accountant.rpc('deposit_cash_to_bank', { p_amount_paise: rupees(100) })));

    await cashier.rpc('deposit_cash_to_bank', { p_amount_paise: rupees(600), p_reference: 'SBI slip 0042' });
    fund = await cashier.fund();
    expect('cash in hand falls by the deposit', Number(fund.cash_float_paise), held - rupees(600));
    expect('the fund does not move', Number(fund.total_fund_paise), fundNow);
    expect('the bank is now expected to hold it',
      Number(fund.expected_bank_balance_paise),
      Number(fund.total_fund_paise) - Number(fund.outstanding_paise) - Number(fund.cash_float_paise));

    // --- the daily digest --------------------------------------------------
    if (target === 'local') {
      const sub = (who, n) => who.rpc('save_push_subscription', {
        p_endpoint: `https://fcm.googleapis.com/fcm/send/test-${n}-${Date.now()}`,
        p_p256dh: 'BPtest', p_auth: 'authtest', p_lang: n % 2 ? 'te' : 'en',
      });
      await sub(cashier, 1); await sub(devi, 2); await sub(everyone[0], 3);
      note('refused: ' + await devi.cannot('register a push endpoint that is not a push service', () =>
        devi.rpc('save_push_subscription', {
          p_endpoint: 'https://evil.example/collect', p_p256dh: 'x', p_auth: 'y',
        })));

      // A claim waiting for the cashier, from someone else.
      const chandra = everyone[2];
      await chandra.rpc('claim_payment', {
        p_period_id: club.periodId, p_amount_paise: rupees(1000), p_method: 'upi', p_reference: 'UTR7777',
      });

      const due = await club.driver.raw(
        'select d.* from notifications_due() d where d.group_name = (select name from groups where id = $1)',
        [club.groupId],
      );
      const forUser = (who) => due.filter((d) => d.auth_user_id === who.user.id).map((d) => d.kind);
      expect('the cashier is told a claim is waiting', forUser(cashier).includes('claims_to_confirm'), true);
      expect('a fully-paid member is not told to pay', forUser(devi).includes('contribution_due')
        || forUser(devi).includes('contribution_overdue'), false);
      expect('nobody without a device is told anything',
        due.every((d) => [cashier, devi, everyone[0]].some((w) => w.user.id === d.auth_user_id)), true);
      const leaked = await club.driver.raw("select current_setting('request.jwt.claims', true) as c");
      expect('the impersonation is undone afterwards', leaked[0].c ?? '', '');
      note(`digest rows: ${due.map((d) => d.kind).join(', ')}`);
    }
  },
};
