/**
 * A loan from request to repayment, and the things that must be refused.
 *
 * The interesting part is not that a loan works -- it is that a borrower
 * cannot vote for themselves, a guarantor cannot either, the cashier cannot
 * pay out their own loan, and the cap holds.
 */

export default {
  name: 'loans',
  describe: 'request, vote, pay out, repay, and everything that is refused',

  async run({ club, expect, note, rupees, target }) {
    const { admin, cashier, accountant, everyone } = await club.withMembers(
      ['Anita', 'Bhaskar', 'Chandra', 'Devi', 'Esha'],
      { monthly: rupees(2000), p_loan_required_approvals: 2 },
    );
    const [, , chandra, devi, esha] = everyone;

    await club.openMonth(cashier);
    for (const m of everyone) await cashier.takesPayment(m, rupees(2000));

    const fund = await cashier.fund();
    note(`fund Rs.${(Number(fund.total_fund_paise) / 100).toFixed(0)}, ` +
      `one member may borrow Rs.${(Number(fund.per_member_cap_paise) / 100).toFixed(0)}`);

    // Over the per-member cap is refused, and the message says the figure.
    const tooBig = await devi.cannot('borrow more than the cap', () =>
      devi.asksToBorrow(Number(fund.total_fund_paise), { from: chandra }),
    );
    note(`refused: ${tooBig}`);

    // Within the cap, and someone else vouches.
    const loan = await devi.asksToBorrow(rupees(1500), { from: chandra, months: 6 });
    expect('loan starts as requested', loan.status, 'requested');

    // The borrower cannot vote for themselves...
    const self = await devi.cannot('vote on own loan', () => devi.votesOnLoan(loan.id));
    note(`refused: ${self}`);
    // ...and neither can the guarantor, who has an obvious interest (0022).
    const guar = await chandra.cannot('vote as guarantor', () => chandra.votesOnLoan(loan.id));
    note(`refused: ${guar}`);

    await admin.votesOnLoan(loan.id, 'approve');
    await esha.votesOnLoan(loan.id, 'approve');

    let [row] = (await cashier.loans()).filter((l) => l.id === loan.id);
    expect('approved once enough said yes', row.status, 'approved');

    await cashier.paysOutLoan(loan.id);
    [row] = (await cashier.loans()).filter((l) => l.id === loan.id);
    expect('paid out', row.status, 'disbursed');
    expect('still owed in full', Number(row.outstanding_principal_paise), rupees(1500));

    // Equal principal over six months: the schedule must sum to the loan.
    const sched = await cashier.read('loan_instalments', { eq: { loan_id: loan.id } });
    expect('six instalments', sched.length, 6);
    expect('schedule sums to the loan',
      sched.reduce((s, i) => s + Number(i.principal_paise), 0), rupees(1500));

    await cashier.takesRepayment(loan.id, { principal: rupees(500), interest: rupees(30) });
    [row] = (await cashier.loans()).filter((l) => l.id === loan.id);
    expect('outstanding falls by what was repaid',
      Number(row.outstanding_principal_paise), rupees(1000));

    const after = await cashier.fund();
    expect('interest received is now in the fund',
      Number(after.interest_received_paise), rupees(30));
    expect('books still balance',
      Number(after.total_fund_paise) - Number(after.outstanding_paise) - Number(after.cash_float_paise),
      Number(after.expected_bank_balance_paise));

    // Behind on the plan reads as overdue even mid-term (0027). Needs the
    // clock moved, which only the local driver can do.
    if (target === 'local') {
      // Ageing alone is not enough to be behind: the Rs.500 already repaid
      // covers the two instalments that fall due in 90 days, so arrears is
      // correctly zero. Age further, so more has come due than was paid.
      await club.age(loan.id, 150);
      [row] = (await cashier.loans()).filter((l) => l.id === loan.id);
      expect('behind on the plan', Number(row.arrears_paise) > 0, true);
      expect('and flagged overdue before the term ends', row.is_overdue, true);
      expect('though the final date has not passed', Number(row.days_overdue), 0);
      note(`Rs.${(Number(row.arrears_paise) / 100).toFixed(0)} behind after 5 months, ` +
        `with Rs.500 repaid -- and the final date still ahead`);
    } else {
      note('skipped the arrears check -- it needs to move the clock (local only)');
    }
  },
};
