window.DEPLOYMENT = {
  "network": "localhost",
  "chainId": 31337,
  "deployedAt": "2026-11-03T04:38:42.614Z",
  "expiry": 1793939913,
  "settlementWindow": 600,
  "usdc": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  "oracle": "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  "protocol": "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  "gap": "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  "rpc": "http://127.0.0.1:8545",
  "mocks": true,
  "stocks": [
    {
      "symbol": "NVDAx",
      "name": "NVIDIA xStock",
      "spot": 200,
      "vol": 0.5,
      "address": "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
      "series": [
        {
          "id": 0,
          "isCall": false,
          "strike": 180,
          "token": "0x75537828f2ce51be7289709686A69CbFDbB714F1"
        },
        {
          "id": 1,
          "isCall": false,
          "strike": 190,
          "token": "0xE451980132E65465d0a498c53f0b5227326Dd73F"
        },
        {
          "id": 2,
          "isCall": false,
          "strike": 195,
          "token": "0x5392A33F7F677f59e833FEBF4016cDDD88fF9E67"
        },
        {
          "id": 3,
          "isCall": true,
          "strike": 205,
          "token": "0xa783CDc72e34a174CCa57a6d9a74904d0Bec05A9"
        },
        {
          "id": 4,
          "isCall": true,
          "strike": 210,
          "token": "0xB30dAf0240261Be564Cea33260F01213c47AAa0D"
        },
        {
          "id": 5,
          "isCall": true,
          "strike": 220,
          "token": "0x61ef99673A65BeE0512b8d1eB1aA656866D24296"
        }
      ],
      "gapRound": 0,
      "vault": "0x9A676e781A523b5d0C0e43731313A708CB607508",
      "lender": "0x0B306BF915C4d645ff596e518fAf3F9669b97016"
    },
    {
      "symbol": "TSLAx",
      "name": "Tesla xStock",
      "spot": 440,
      "vol": 0.65,
      "address": "0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1",
      "series": [
        {
          "id": 6,
          "isCall": false,
          "strike": 395,
          "token": "0xF45bcaDCc83dea176213Ae4E22f5aF918d08647b"
        },
        {
          "id": 7,
          "isCall": false,
          "strike": 417.5,
          "token": "0xeCaE6Cc78251a4F3B8d70c9BD4De1B3742338489"
        },
        {
          "id": 8,
          "isCall": false,
          "strike": 430,
          "token": "0x09fe532dFA5FfcaD188ce19A70BB7645ce31a1C8"
        },
        {
          "id": 9,
          "isCall": true,
          "strike": 450,
          "token": "0x53F3788A62b46B8a45484F928Ef182Fd2c149C2b"
        },
        {
          "id": 10,
          "isCall": true,
          "strike": 462.5,
          "token": "0x51f9613a79D56528622Bd31a5Fd4b88b78AE4F8A"
        },
        {
          "id": 11,
          "isCall": true,
          "strike": 485,
          "token": "0x9133c237A3f4Ce9F48A73Ea03e0448e10cd2f5C1"
        }
      ],
      "gapRound": 1,
      "vault": "0x7a2088a1bFc9d81c55368AE168C2C02570cB814F",
      "lender": "0x09635F643e140090A9A8Dcd712eD6285858ceBef"
    },
    {
      "symbol": "SPYx",
      "name": "SP500 xStock",
      "spot": 680,
      "vol": 0.18,
      "address": "0xc5a5C42992dECbae36851359345FE25997F5C42d",
      "series": [
        {
          "id": 12,
          "isCall": false,
          "strike": 610,
          "token": "0xC366737A5E66127E2dD410aF9D341945a889eF2E"
        },
        {
          "id": 13,
          "isCall": false,
          "strike": 645,
          "token": "0xF5A81C89bCe2c711BC0a91B19BA4c31d9aeA0875"
        },
        {
          "id": 14,
          "isCall": false,
          "strike": 665,
          "token": "0xFD4727f95FC2Df074C427158f9244FeB4B6d3076"
        },
        {
          "id": 15,
          "isCall": true,
          "strike": 695,
          "token": "0x09Df20712491189de6607Fb27bB1DeE53ACB8555"
        },
        {
          "id": 16,
          "isCall": true,
          "strike": 715,
          "token": "0x84D6E95B602df56E3637210F5Dbcc6d23a20C467"
        },
        {
          "id": 17,
          "isCall": true,
          "strike": 750,
          "token": "0x57E1Fa3f9Bf8f4822A8590df964adFf6fd823c37"
        }
      ],
      "gapRound": 2,
      "vault": "0x95401dc811bb5740090279Ba06cfA8fcF6113778",
      "lender": "0x998abeb3E57409262aE5b751f60747921B33613E"
    }
  ]
};
