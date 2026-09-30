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
    // Whatever the quote says: Rs.1,000, or Rs.1,050 when the run happens to
    // fall after the grace date.
    const sent = Number([].concat(await devi.rpc('payment_quote', { p_period_id: club.periodId }))[0].to_pay_paise);
    const claim = await devi.rpc('claim_payment', {
      p_period_id: club.periodId, p_amount_paise: sent,
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
    // Exactly what was sent -- a fee, if one applied, is inside the claim, not
    // on top of it (0049).
    expect('fund grows by exactly what was sent',
      Number((await cashier.fund()).total_fund_paise), fundBefore + sent);
    expect('and the ledger row adds up to the claim',
      Number(rows[0].amount_paise) + Number(rows[0].late_fee_paise), sent);
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

      // --- a LATE payment: the fee is asked for, and inside the claim ------
      // The month's grace ended yesterday; the group charges Rs.50.
      await club.driver.raw(
        `update contribution_periods set due_date = current_date - 1, grace_date = current_date - 1
          where id = $1`, [club.periodId]);
      await club.driver.raw('update groups set late_fee_paise = $2 where id = $1', [club.groupId, rupees(50)]);
      const chandra = everyone[2];
      const q = [].concat(await chandra.rpc('payment_quote', { p_period_id: club.periodId }))[0];
      expect('a late payer is quoted the deposit plus the fee', Number(q.to_pay_paise), rupees(1050));
      expect('with the fee shown on its own', Number(q.late_fee_paise), rupees(50));
      note('refused: ' + await chandra.cannot('claim more than deposit + fee', () =>
        chandra.rpc('claim_payment', {
          p_period_id: club.periodId, p_amount_paise: rupees(1051), p_method: 'upi', p_reference: 'UTR7776',
        })));

      // A claim waiting for the cashier, from someone else.
      const late = await chandra.rpc('claim_payment', {
        p_period_id: club.periodId, p_amount_paise: rupees(1050), p_method: 'upi', p_reference: 'UTR7777',
      });
      const q2 = [].concat(await chandra.rpc('payment_quote', { p_period_id: club.periodId }))[0];
      expect('nothing more to send once it is claimed', Number(q2.to_pay_paise), 0);

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

      // Confirming the late claim records Rs.1,000 + Rs.50 = the Rs.1,050
      // that arrived. Before 0049 it recorded Rs.1,100.
      const before = Number((await cashier.fund()).total_fund_paise);
      await cashier.rpc('confirm_payment_claim', { p_claim_id: late.id });
      const [lateRow] = await cashier.read('contributions', { eq: { member_id: chandra.memberId } });
      expect('late claim: deposit part', Number(lateRow.amount_paise), rupees(1000));
      expect('late claim: fee part', Number(lateRow.late_fee_paise), rupees(50));
      expect('late claim: fund grows by exactly what arrived',
        Number((await cashier.fund()).total_fund_paise), before + rupees(1050));
    }
  },
};
