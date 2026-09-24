// Successful complete children from failed PR-shaped run 36038423993 at 3c1e89b8a064.
// Keys bind the execution runner, job environment and complete ordered child contract.
// The two RunsOn memory32 samples (jobs 107766128467/107766128662) used the
// diversified 8–16 CPU / 32–48 GiB on-demand pool: actual m8a.2xlarge, eight CPUs.
// Job 107766133218 retained Blacksmith32 with eight actual CPUs. These observations
// do not qualify the failed workflow or transfer AWS timings to Blacksmith.
// Complete serial cohorts also bind jobs 107766128451 (RunsOn memory32) and
// 107766128634 (Blacksmith32, retaining the update-CLI envelope provider).
// Their companions have no independent AWS performance comparison.
// Prices use S1's ceil(native child span * 1.10) + 2; job overhead stays with packing.
export const measuredSerialGroupSeconds: Record<"push" | "pull-request", Record<string, number>> = {
  push: {},
  "pull-request": {
    a5b13b2c117c19dc0be448874dc6b9558997de0d57994ab97e7eb4d7bdfdb393: 144,
    c9afc478074ac0f09d8c7dc983ccf19838d6cfbdc1cea6d2fd14e546990bd1d4: 197,
    dd116efa324d24068cf8761d24b78cbeb0172542ab60dc73f9ea9ea058d023cc: 224,
    "50b187e61413eddf9fcfd81c390849098e4da9f5c5f01705181efb39b38d992a": 235,
    "75c55e6e18d9d6c1ae25e7cad2c633a6582058840e977fcbf345337e7c6d16dc": 155,
    "223166a2831a3e537670cda68305702c24b74f569d7776847e77d12ea9933a44": 190,
    e5312709a3b76e0164b52561fed601da1558689901fc8de17a20905057c62a0c: 432,
    "0b97df3f35fa2ccac85652140430f67b0d7ef919527d6cfa8965148d8719a4a3": 412,
    "76570df1d2c3360583f9c47931d018e34c8382d23164af0704e20b3ceb058f0b": 251,
  },
};

// Hash the ordered complete child keys; partial or reordered cohorts cannot use
// aggregate placement observations.
export const measuredSerialJobKeys: Record<"push" | "pull-request", readonly string[]> = {
  push: [],
  "pull-request": [
    "19a1e5267dcba7e04b71f66e546acf570c5bf1ca2dd74ccf60e21eed2aa58474",
    "28e0ea0119ad665dfc67e1054c1aa8045163106ac52bbe74a27ed0943f2480a8",
  ],
};
