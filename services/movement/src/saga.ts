import { randomUUID } from 'node:crypto';
import type { ChainDriver, ChainId } from '@arc/chain';
import { Money } from '@arc/money';
import type { Quote } from './quotes.js';
import type { CompliancePort, JournalEntryInput, LedgerPort, PostedJournalRef } from './ports.js';
import { RailError, type BankRail } from './rails.js';

export class SagaError extends Error {
  constructor(
    readonly step: SagaStepName,
    readonly detail: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'SagaError';
  }
}

export type SagaStepName = 'compliance' | 'reserve' | 'swap' | 'settle' | 'payout';

export type SagaStatus = 'completed' | 'compensated' | 'compensation_failed';

export interface AccountRefs {
  readonly senderCustomer: string;
  readonly beneficiaryIdentifier: string;
  readonly inTransitSend: string;
  readonly inTransitReceive: string;
  readonly corridorFee: string;
  readonly fxSpread: string;
  readonly fxPositionSend: string;
  readonly fxPositionSettlement: string;
  readonly chainFloat: string;
  readonly bankFloatReceive: string;
  readonly networkFeeExpense: string;
  readonly chainFloatFeeAsset: string;
}

export interface TransferInput {
  readonly transferId?: string;
  readonly quote: Quote;
  readonly accounts: AccountRefs;
  readonly chain: ChainId;
  readonly settlementFrom: string;
  readonly settlementTo: string;
}

export interface SagaContext {
  readonly transferId: string;
  readonly quote: Quote;
  readonly accounts: AccountRefs;
  readonly journals: PostedJournalRef[];
  readonly completedSteps: SagaStepName[];
  chainTxHash?: string;
  payoutId?: string;
  railReference?: string;
}

export interface SagaResult {
  readonly transferId: string;
  readonly status: SagaStatus;
  readonly completedSteps: readonly SagaStepName[];
  readonly failedStep?: SagaStepName;
  readonly reason?: string;
  readonly chainTxHash?: string;
  readonly railReference?: string;
}

export interface SagaHooks {
  /** Throw here to inject a failure before a step runs. Used by the chaos suite. */
  beforeStep?(step: SagaStepName, context: SagaContext): Promise<void>;
}

export interface SagaDependencies {
  ledger: LedgerPort;
  compliance: CompliancePort;
  chain: ChainDriver;
  rail: BankRail;
  hooks?: SagaHooks;
  /** Blocks to advance while waiting for finality; the simulator has no wall clock. */
  advanceChain?: (hash: string) => void;
}

interface Step {
  readonly name: SagaStepName;
  execute(context: SagaContext): Promise<void>;
  compensate(context: SagaContext): Promise<void>;
}

function reverse(entries: readonly JournalEntryInput[]): JournalEntryInput[] {
  return entries.map((e) => ({
    account: e.account,
    direction: e.direction === 'debit' ? 'credit' : 'debit',
    amount: e.amount,
  }));
}

export class SettlementSaga {
  constructor(private readonly deps: SagaDependencies) {}

  async execute(input: TransferInput): Promise<SagaResult> {
    const context: SagaContext = {
      transferId: input.transferId ?? randomUUID(),
      quote: input.quote,
      accounts: input.accounts,
      journals: [],
      completedSteps: [],
    };

    const steps = this.buildSteps(input);

    for (const step of steps) {
      try {
        if (this.deps.hooks?.beforeStep) {
          await this.deps.hooks.beforeStep(step.name, context);
        }
        await step.execute(context);
        context.completedSteps.push(step.name);
      } catch (error) {
        const compensated = await this.compensate(steps, context);
        return {
          transferId: context.transferId,
          status: compensated ? 'compensated' : 'compensation_failed',
          completedSteps: [...context.completedSteps],
          failedStep: step.name,
          reason: error instanceof Error ? error.message : String(error),
          ...(context.chainTxHash ? { chainTxHash: context.chainTxHash } : {}),
        };
      }
    }

    return {
      transferId: context.transferId,
      status: 'completed',
      completedSteps: [...context.completedSteps],
      ...(context.chainTxHash ? { chainTxHash: context.chainTxHash } : {}),
      ...(context.railReference ? { railReference: context.railReference } : {}),
    };
  }

  /** Undo completed steps in reverse order. */
  private async compensate(steps: readonly Step[], context: SagaContext): Promise<boolean> {
    const done = [...context.completedSteps].reverse();
    let allSucceeded = true;

    for (const name of done) {
      const step = steps.find((s) => s.name === name)!;
      try {
        await step.compensate(context);
      } catch {
        allSucceeded = false;
      }
    }
    return allSucceeded;
  }

  private buildSteps(input: TransferInput): Step[] {
    const { quote, accounts } = input;
    const { ledger, compliance, chain, rail } = this.deps;

    const netSend = quote.sendAmount.subtract(
      quote.fees
        .filter((f) => f.amount.currency === quote.sendAmount.currency)
        .reduce((a, f) => a.add(f.amount), Money.zero(quote.sendAmount.currency)),
    );

    const corridorFee =
      quote.fees.find((f) => f.kind === 'corridor')?.amount ??
      Money.zero(quote.sendAmount.currency);
    const networkFee =
      quote.fees.find((f) => f.kind === 'network')?.amount ?? Money.zero(quote.sendAmount.currency);
    const spreadFee = corridorFee.add(networkFee).isZero
      ? quote.sendAmount.subtract(netSend)
      : quote.sendAmount.subtract(netSend).subtract(corridorFee).subtract(networkFee);

    const reserveEntries: JournalEntryInput[] = [
      { account: accounts.senderCustomer, direction: 'debit', amount: quote.sendAmount },
      { account: accounts.inTransitSend, direction: 'credit', amount: netSend },
    ];
    if (corridorFee.isPositive) {
      reserveEntries.push({
        account: accounts.corridorFee,
        direction: 'credit',
        amount: corridorFee.add(networkFee),
      });
    }
    if (spreadFee.isPositive) {
      reserveEntries.push({ account: accounts.fxSpread, direction: 'credit', amount: spreadFee });
    }

    const swapEntries: JournalEntryInput[] = [
      { account: accounts.inTransitSend, direction: 'debit', amount: netSend },
      { account: accounts.fxPositionSend, direction: 'credit', amount: netSend },
      { account: accounts.chainFloat, direction: 'debit', amount: quote.settlementAmount },
      {
        account: accounts.fxPositionSettlement,
        direction: 'credit',
        amount: quote.settlementAmount,
      },
    ];

    const settleEntries: JournalEntryInput[] = [
      {
        account: accounts.fxPositionSettlement,
        direction: 'debit',
        amount: quote.settlementAmount,
      },
      { account: accounts.chainFloat, direction: 'credit', amount: quote.settlementAmount },
      { account: accounts.bankFloatReceive, direction: 'debit', amount: quote.receiveAmount },
      { account: accounts.inTransitReceive, direction: 'credit', amount: quote.receiveAmount },
    ];

    const payoutEntries: JournalEntryInput[] = [
      { account: accounts.inTransitReceive, direction: 'debit', amount: quote.receiveAmount },
      { account: accounts.bankFloatReceive, direction: 'credit', amount: quote.receiveAmount },
    ];

    const postAndTrack = async (
      context: SagaContext,
      kind: 'transfer' | 'fx' | 'settlement' | 'reversal',
      description: string,
      entries: readonly JournalEntryInput[],
    ) => {
      const posted = await ledger.post({
        kind,
        referenceId: context.transferId,
        description,
        entries,
      });
      context.journals.push(posted);
      return posted;
    };

    const reverseLast = async (context: SagaContext, description: string) => {
      const posted = context.journals.pop();
      if (!posted) return;
      await ledger.post({
        kind: 'reversal',
        referenceId: context.transferId,
        description,
        entries: reverse(posted.entries),
      });
    };

    return [
      {
        name: 'compliance',
        execute: async (context) => {
          const verdict = await compliance.screenTransfer({
            transferId: context.transferId,
            senderAccount: accounts.senderCustomer,
            beneficiary: accounts.beneficiaryIdentifier,
            amount: quote.sendAmount,
            corridor: quote.corridor,
          });
          if (verdict.decision !== 'approved') {
            throw new SagaError(
              'compliance',
              verdict,
              `compliance ${verdict.decision}: ${verdict.reasons.join(', ') || 'no reason given'}`,
            );
          }
        },
        compensate: async () => {},
      },

      {
        name: 'reserve',
        execute: async (context) => {
          await postAndTrack(
            context,
            'transfer',
            'Reserve sender funds and take fees',
            reserveEntries,
          );
        },
        compensate: async (context) => {
          await reverseLast(context, 'Refund sender: transfer unwound');
        },
      },

      {
        name: 'swap',
        execute: async (context) => {
          await postAndTrack(
            context,
            'fx',
            `Swap ${netSend.toString()} to ${quote.settlementAmount.toString()}`,
            swapEntries,
          );
        },
        compensate: async (context) => {
          await reverseLast(context, 'Unwind swap');
        },
      },

      {
        name: 'settle',
        execute: async (context) => {
          const broadcast = await chain.broadcast({
            asset: quote.settlementAmount.currency,
            amount: quote.settlementAmount,
            from: input.settlementFrom,
            to: input.settlementTo,
            idempotencyKey: `${context.transferId}:settle`,
          });
          context.chainTxHash = broadcast.hash;

          this.deps.advanceChain?.(broadcast.hash);

          const settled = await chain.getTransaction(broadcast.hash);
          if (!settled || !settled.final) {
            throw new SagaError(
              'settle',
              settled,
              `on-chain settlement did not reach finality (status ${settled?.status ?? 'unknown'})`,
            );
          }

          await postAndTrack(context, 'settlement', 'On-chain settlement', settleEntries);

          if (settled.fee.isPositive) {
            await ledger.post({
              kind: 'fee',
              referenceId: context.transferId,
              description: 'Network fee',
              entries: [
                { account: accounts.networkFeeExpense, direction: 'debit', amount: settled.fee },
                { account: accounts.chainFloatFeeAsset, direction: 'credit', amount: settled.fee },
              ],
            });
          }
        },
        compensate: async (context) => {
          await reverseLast(context, 'Unwind settlement: funds recovered from partner');
        },
      },

      {
        name: 'payout',
        execute: async (context) => {
          const payoutId = randomUUID();
          context.payoutId = payoutId;

          const receipt = await rail.submit({
            payoutId,
            beneficiary: accounts.beneficiaryIdentifier,
            amount: quote.receiveAmount,
            reference: context.transferId,
            idempotencyKey: `${context.transferId}:payout`,
          });

          if (receipt.outcome !== 'accepted') {
            throw new SagaError('payout', receipt, `rail returned ${receipt.outcome}`);
          }
          context.railReference = receipt.railReference;

          await postAndTrack(context, 'settlement', 'Payout to beneficiary', payoutEntries);
        },
        compensate: async (context) => {
          if (context.payoutId) {
            try {
              await rail.recall(context.payoutId);
            } catch (error) {
              if (!(error instanceof RailError)) throw error;
            }
          }
          await reverseLast(context, 'Unwind payout');
        },
      },
    ];
  }
}
