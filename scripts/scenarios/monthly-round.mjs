/**
 * The ordinary month: four people, everyone pays, one pays late and in parts.
 *
 * This is the path the app walks every month of its life, so if anything
 * here is wrong nothing else matters.
 */

export default {
  name: 'monthly-round',
  describe: 'a normal month: open, collect, part-pay, late fee',

  async run({ club, expect, note, rupees }) {
    const { admin, cashier, everyone } = await club.withMembers(
      ['Anita', 'Bhaskar', 'Chandra', 'Devi'],
      { monthly: rupees(1000), p_late_fee_paise: rupees(50) },
    );

    await club.openMonth(cashier);
    note(`group of ${everyone.length}, Rs.1000 a month each`);

    // Everyone pays in full except Devi.
    for (const m of everyone.slice(0, 3)) {
      await cashier.takesPayment(m, rupees(1000));
    }

    // The fund holds the payments AND the late fees. Whether a fee applies
    // depends on the day this runs against the group's grace day, so assert
    // the rule rather than a number that is only right some of the month.
    let fund = await cashier.fund();
    const fees3 = (await cashier.read('contributions'))
      .reduce((s, r) => s + Number(r.late_fee_paise), 0);
    expect('fund = payments + whatever late fees applied',
      Number(fund.total_fund_paise), rupees(3000) + fees3);

    // Devi pays in parts. Before 0026 the first part marked her settled and
    // she vanished off the chase-list -- so this is the check that matters.
    await cashier.takesPayment(everyone[3], rupees(400));

    const chasing = await cashier.unpaid();
    const devi = chasing.find((u) => u.full_name === 'Devi');
    expect('part-payer is still on the chase-list', Boolean(devi), true);
    expect('and it asks for the shortfall only', Number(devi?.shortfall_paise), rupees(600));

    await cashier.takesPayment(everyone[3], rupees(600));
    const after = await cashier.unpaid();
    expect('settled once the rest arrives', after.length, 0);

    // The late fee is charged once per member per month, however many
    // instalments follow.
    const rows = await cashier.read('contributions', { eq: { member_id: everyone[3].memberId } });
    const fees = rows.reduce((s, r) => s + Number(r.late_fee_paise), 0);
    // Late once is late once, however many instalments follow (0026).
    expect('late fee charged at most once', fees <= rupees(50), true);
    expect('both of her payments recorded', rows.length, 2);
    expect('and only the first carried a fee',
      rows.filter((r) => Number(r.late_fee_paise) > 0).length <= 1, true);

    // Overpaying is refused outright.
    const msg = await cashier.cannot('overpay a settled month', () =>
      cashier.takesPayment(everyone[3], rupees(1)),
    );
    note(`refused: ${msg}`);

    // A plain member cannot take money in. The gate is the database's, not
    // the screen's -- which is the whole design.
    const denied = await everyone[3].cannot('record a payment as a member', () =>
      everyone[3].takesPayment(everyone[0], rupees(100)),
    );
    note(`refused: ${denied}`);

    fund = await cashier.fund();
    expect('fund holds everything paid in', Number(fund.contributions_paise) >= rupees(4000), true);
    expect(
      'books balance',
      Number(fund.total_fund_paise) - Number(fund.outstanding_paise) - Number(fund.cash_float_paise),
      Number(fund.expected_bank_balance_paise),
    );
  },
};
