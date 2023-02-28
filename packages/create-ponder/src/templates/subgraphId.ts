import { writeFileSync } from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import prettier from "prettier";
import type {
  PartialPonderConfig,
  PonderContract,
  PonderNetwork,
} from "src/index";
import { parse } from "yaml";

import { getGraphProtocolChainId } from "@/helpers/getGraphProtocolChainId";
import { validateGraphProtocolSource } from "@/helpers/validateGraphProtocolSource";

const fetchIpfsFile = async (cid: string) => {
  const url = `https://ipfs.network.thegraph.com/api/v0/cat?arg=${cid}`;
  const response = await fetch(url);
  const contentRaw = await response.text();
  return contentRaw;
};

export const fromSubgraphId = async ({
  rootDir,
  subgraphId,
}: {
  rootDir: string;
  subgraphId: string;
}) => {
  const ponderNetworks: PonderNetwork[] = [];
  let ponderContracts: PonderContract[] = [];

  // Fetch the manifest file.
  const manifestRaw = await fetchIpfsFile(subgraphId);
  const manifest = parse(manifestRaw);

  // Fetch and write the schema.graphql file.
  const schemaCid = manifest.schema.file["/"].slice(6);
  const schemaRaw = await fetchIpfsFile(schemaCid);
  const ponderSchemaFilePath = path.join(rootDir, "schema.graphql");
  writeFileSync(
    ponderSchemaFilePath,
    prettier.format(schemaRaw, { parser: "graphql" })
  );

  const dataSources = (manifest.dataSources as unknown[]).map(
    validateGraphProtocolSource
  );

  // Fetch and write all referenced ABIs.
  const abiFiles = dataSources
    .map((source) => source.mapping.abis)
    .flat()
    .filter(
      (source, idx, arr) => arr.findIndex((s) => s.name === source.name) === idx
    );
  await Promise.all(
    abiFiles.map(async (abi) => {
      const abiContent = await fetchIpfsFile(abi.file["/"].slice(6));
      const abiPath = path.join(rootDir, `./abis/${abi.name}.json`);
      writeFileSync(abiPath, prettier.format(abiContent, { parser: "json" }));
    })
  );

  // Build the ponder sources.
  ponderContracts = dataSources.map((source) => {
    const network = source.network || "mainnet";
    const chainId = getGraphProtocolChainId(network);
    if (!chainId || chainId === -1) {
      throw new Error(`Unhandled network name: ${network}`);
    }

    if (!ponderNetworks.map((n) => n.name).includes(network)) {
      ponderNetworks.push({
        name: network,
        chainId: chainId,
        rpcUrl: `process.env.PONDER_RPC_URL_${chainId}`,
      });
    }

    const abiRelativePath = `./abis/${source.source.abi}.json`;

    return <PonderContract>{
      name: source.name,
      network: network,
      address: source.source.address,
      abi: abiRelativePath,
      startBlock: source.source.startBlock,
    };
  });

  // Build the partial ponder config.
  const ponderConfig: PartialPonderConfig = {
    networks: ponderNetworks,
    contracts: ponderContracts,
  };

  return ponderConfig;
};
