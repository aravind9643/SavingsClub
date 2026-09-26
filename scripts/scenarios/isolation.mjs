/**
 * Two groups side by side. Can a member of one touch a rupee of the other?
 *
 * This is THE property. Everything else in the app is a convenience; this
 * is the one that must not have an exception -- and one real leak lived
 * here for 25 migrations, so it is not hypothetical.
 *
 * Deliberately gives the two groups DIFFERENT amounts: if any figure is
 * unscoped the total comes back inflated rather than merely wrong, which
 * is impossible to misread.
 */

export default {
  name: 'isolation',
  describe: 'two groups at once, and every way one might see the other',

  async run({ club, expect, note, rupees, target }) {
    // Group A: rich.
    const a = await club.withMembers(['Amma', 'Appa'], { monthly: rupees(5000) });
    await club.openMonth(a.cashier);
    for (const m of a.everyone) await a.cashier.takesPayment(m, rupees(5000));
    const groupA = club.groupId;
    const fundA = await a.cashier.fund();
    note(`group A holds Rs.${(Number(fundA.total_fund_paise) / 100).toFixed(0)}`);

    // Group B: poor, and a completely separate set of people.
    const { Club } = await import('../lib/club.mjs');
    const clubB = new Club(club.driver);
    const b = await clubB.withMembers(['Bala', 'Bhanu'], { monthly: rupees(100) });
    await clubB.openMonth(b.cashier);
    for (const m of b.everyone) await b.cashier.takesPayment(m, rupees(100));
    const fundB = await b.cashier.fund();
    note(`group B holds Rs.${(Number(fundB.total_fund_paise) / 100).toFixed(0)}`);

    expect('each group sees only its own money',
      Number(fundB.total_fund_paise) < Number(fundA.total_fund_paise), true);

    // --- Bala points his claim at group A ---------------------------------

    const bala = b.cashier;
    const sawMembers = await club.driver.select(bala.user, groupA, 'members');
    expect('a forged claim shows no members', sawMembers.length, 0);

    const sawMoney = await club.driver.select(bala.user, groupA, 'contributions');
    expect('and no payments', sawMoney.length, 0);

    // `groups` is the one table that intentionally does NOT filter on the
    // claim: its policy is "groups you belong to", so the group switcher
    // can list them. The right assertion is that group A is not among them
    // -- asserting zero rows would be asserting the switcher is broken.
    const sawGroups = await club.driver.select(bala.user, groupA, 'groups');
    expect('group A is not in the list he can see',
      sawGroups.some((g) => g.id === groupA), false);
    expect('only his own group is', sawGroups.length, 1);

    // The sharp edge: SECURITY DEFINER money functions bypass RLS entirely,
    // so the only thing stopping this is the membership check inside them.
    let leaked = null;
    try {
      leaked = await club.driver.rpc(bala.user, groupA, 'fn_fund_total_paise', {
        p_group_id: groupA,
      });
    } catch (e) {
      note(`refused: ${e.message}`);
    }
    expect('a money aggregate refuses a non-member', leaked, null);

    // Writing across is refused too.
    const wrote = await bala.cannot('record a payment into another group', () =>
      club.driver.rpc(bala.user, groupA, 'record_contribution', {
        p_period_id: club.periodId,
        p_member_id: a.everyone[0].memberId,
        p_amount_paise: rupees(1),
      }),
    );
    note(`refused: ${wrote}`);

    // And the whole ledger cannot be lifted.
    let exported = null;
    try {
      exported = await club.driver.rpc(bala.user, groupA, 'export_group_data');
    } catch (e) {
      note(`refused: ${e.message}`);
    }
    const exportedName = exported?.group?.name ?? null;
    expect('cannot export another group', exportedName === 'Test Group', false);

    // Back where he belongs, everything still works.
    const mine = await b.cashier.fund();
    expect('his own group is unaffected',
      Number(mine.total_fund_paise), Number(fundB.total_fund_paise));
  },
};
