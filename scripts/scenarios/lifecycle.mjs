/**
 * The events that end things: someone leaves, the group shares out and closes.
 *
 * These are the moments savings groups argue about, and the ones the app
 * could not model at all until 0025-0029. A member leaving without being
 * paid used to have their savings silently absorbed into the fund.
 */

export default {
  name: 'lifecycle',
  describe: 'a member leaves, profit is shared, the group winds up',

  async run({ club, expect, note, rupees }) {
    const { admin, cashier, everyone } = await club.withMembers(
      ['Anita', 'Bhaskar', 'Chandra'],
      { monthly: rupees(1000) },
    );
    const [, , chandra] = everyone;

    await club.openMonth(cashier);
    for (const m of everyone) await cashier.takesPayment(m, rupees(1000));

    // --- someone leaves ---------------------------------------------------

    const before = await cashier.fund();
    const pos = (await cashier.positions()).find((p) => p.member_id === chandra.memberId);
    note(`Chandra paid in Rs.${(Number(pos.contributed_paise) / 100).toFixed(0)}, ` +
      `would get back Rs.${(Number(pos.share_paise) / 100).toFixed(0)}`);

    expect('a saver is owed something', Number(pos.share_paise) > 0, true);

    // The bug this exists to stop: marking someone gone while the group
    // still holds their money.
    const refused = await admin.cannot('remove a member still owed money', () =>
      admin.removes(chandra),
    );
    note(`refused: ${refused}`);

    await cashier.paysOut(chandra);
    const after = await cashier.fund();
    expect('the fund drops by exactly what was paid out',
      Number(before.total_fund_paise) - Number(after.total_fund_paise),
      Number(after.payouts_paise));

    const nowOwed = (await cashier.positions())
      .find((p) => p.member_id === chandra.memberId);
    expect('nothing owed once paid', Number(nowOwed.share_paise), 0);

    // Chandra is the accountant, so this also exercises a member holding a
    // job on the day they leave -- which used to fail outright with a raw
    // constraint name (fixed in 0040).
    await admin.removes(chandra);
    const left = (await cashier.read('members', { eq: { id: chandra.memberId } }))[0];
    expect('recorded as left, not deleted', left.status, 'left');

    // And the post must actually be vacated, or the group looks like it
    // still has an accountant who is no longer in it.
    const stillHolding = await cashier.read('role_assignments', {
      eq: { member_id: chandra.memberId },
    });
    expect('the job is no longer held by someone who left',
      stillHolding.filter((r) => r.end_date === null).length, 0);

    // --- sharing out and closing -----------------------------------------

    const dist = await cashier.proposesShareOut('final');
    const lines = await cashier.read('v_distribution_lines', {
      eq: { distribution_id: dist.id },
    });
    const sum = lines.reduce((s, l) => s + Number(l.amount_paise), 0);
    expect('the split adds up to the total exactly', sum, Number(dist.total_paise));
    expect('nobody gets a negative amount',
      lines.every((l) => Number(l.amount_paise) >= 0), true);

    // Whoever proposed it cannot also agree it -- the same separation the
    // app applies to paying out a loan.
    const ownVote = await cashier.cannot('agree own share-out', () =>
      cashier.confirmsShareOut(dist.id),
    );
    note(`refused: ${ownVote}`);

    await admin.confirmsShareOut(dist.id);
    const end = await cashier.fund();
    expect('the fund ends at zero', Number(end.total_fund_paise), 0);

    const grp = (await cashier.read('groups', { eq: { id: club.groupId } }))[0];
    expect('and the group is archived', grp.archived_at !== null, true);
  },
};
