/**
 * Service Configuration Reader
 * 
 * Reads service configuration from middleware .operate directory
 * to extract Safe address, agent EOA, and mech contract address.
 * 
 * JINN-209: Enable Safe-based mech marketplace requests
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '../logging/index.js';

const configLogger = logger.child({ component: 'SERVICE-CONFIG-READER' });

export interface ServiceInfo {
  serviceConfigId: string;
  serviceName: string;
  serviceSafeAddress?: string;
  agentEoaAddress?: string;
  mechContractAddress?: string;
  chain: string;
  serviceId?: number;
  stakingContractAddress?: string;
  agentPrivateKey?: string;
}

/**
 * Read service configuration from middleware .operate directory
 * 
 * @param middlewarePath Path to olas-operate-middleware directory
 * @param serviceConfigId Optional service config ID (sc-xxx). If not provided, finds latest.
 * @returns ServiceInfo with Safe address, agent EOA, and mech address
 */
export async function readServiceConfig(
  middlewarePath: string,
  serviceConfigId?: string
): Promise<ServiceInfo | null> {
  try {
    const servicesDir = join(middlewarePath, '.operate', 'services');
    
    // If no serviceConfigId provided, find the latest service by modification time
    let targetServiceId = serviceConfigId;
    if (!targetServiceId) {
      const entries = await fs.readdir(servicesDir, { withFileTypes: true });
      const serviceDirs = entries
        .filter(e => e.isDirectory() && e.name.startsWith('sc-'));
      
      if (serviceDirs.length === 0) {
        configLogger.warn({ servicesDir }, 'No service directories found');
        return null;
      }
      
      // Sort by modification time (newest first)
      const dirsWithStats = await Promise.all(
        serviceDirs.map(async (dir) => {
          const dirPath = join(servicesDir, dir.name);
          const stats = await fs.stat(dirPath);
          return { name: dir.name, mtime: stats.mtime };
        })
      );
      
      dirsWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      targetServiceId = dirsWithStats[0].name;
      configLogger.info({ targetServiceId }, 'Using latest service directory');
    }
    
    // Read service config.json
    const configPath = join(servicesDir, targetServiceId, 'config.json');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);
    
    // Extract service information
    const serviceName = config.name || targetServiceId;
    const homeChain = config.home_chain || 'base';
    
    // Get chain-specific configuration
    const chainConfig = config.chain_configs?.[homeChain]?.chain_data;
    if (!chainConfig) {
      configLogger.warn({ homeChain, serviceConfigId: targetServiceId }, 'Chain configuration not found');
      return {
        serviceConfigId: targetServiceId,
        serviceName,
        chain: homeChain,
      };
    }
    
    const serviceSafeAddress = chainConfig.multisig;
    const serviceId = chainConfig.token;
    const stakingContractAddress = chainConfig.user_params?.staking_program_id;
    
    // Read agent EOA from instances
    let agentEoaAddress: string | undefined;
    const instances = chainConfig.instances || [];
    if (instances.length > 0) {
      agentEoaAddress = instances[0]; // First instance is the agent EOA
    }
    
    // Read mech contract address if deployed
    let mechContractAddress: string | undefined;
    
    // Try to extract from env_variables.MECH_TO_CONFIG (JSON string)
    const mechToConfigEnv = config.env_variables?.MECH_TO_CONFIG?.value;
    if (mechToConfigEnv) {
      try {
        const mechToConfig = JSON.parse(mechToConfigEnv);
        const mechAddresses = Object.keys(mechToConfig);
        if (mechAddresses.length > 0) {
          mechContractAddress = mechAddresses[0]; // Use first mech address
        }
      } catch (error) {
        configLogger.debug({ error: error instanceof Error ? error.message : String(error) }, 'Failed to parse MECH_TO_CONFIG');
      }
    }
    
    // Fallback: Check mech_contracts field (older format)
    if (!mechContractAddress) {
      const mechContracts = config.chain_configs?.[homeChain]?.chain_data?.mech_contracts;
      if (mechContracts && mechContracts.length > 0) {
        mechContractAddress = mechContracts[0];
      }
    }
    
    // Read agent private key from deployment/agent_keys/agent_0/ethereum_private_key.txt
    let agentPrivateKey: string | undefined;
    try {
      const privateKeyPath = join(servicesDir, targetServiceId, 'deployment', 'agent_keys', 'agent_0', 'ethereum_private_key.txt');
      agentPrivateKey = (await fs.readFile(privateKeyPath, 'utf-8')).trim();
    } catch (error) {
      configLogger.debug({ error: error instanceof Error ? error.message : String(error) }, 'Could not read agent private key');
    }
    
    const serviceInfo: ServiceInfo = {
      serviceConfigId: targetServiceId,
      serviceName,
      serviceSafeAddress,
      agentEoaAddress,
      mechContractAddress,
      chain: homeChain,
      serviceId,
      stakingContractAddress,
      agentPrivateKey,
    };
    
    configLogger.info({ serviceInfo }, 'Successfully read service configuration');
    return serviceInfo;
    
  } catch (error) {
    configLogger.error({ error: error instanceof Error ? error.message : String(error), middlewarePath, serviceConfigId }, 'Failed to read service configuration');
    return null;
  }
}

/**
 * List all service configurations in middleware .operate directory
 * 
 * @param middlewarePath Path to olas-operate-middleware directory
 * @returns Array of ServiceInfo objects
 */
export async function listServiceConfigs(middlewarePath: string): Promise<ServiceInfo[]> {
  try {
    const servicesDir = join(middlewarePath, '.operate', 'services');
    const entries = await fs.readdir(servicesDir, { withFileTypes: true });
    const serviceDirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith('sc-'))
      .sort((a, b) => b.name.localeCompare(a.name)); // Sort descending (latest first)
    
    const services: ServiceInfo[] = [];
    for (const dir of serviceDirs) {
      const serviceInfo = await readServiceConfig(middlewarePath, dir.name);
      if (serviceInfo) {
        services.push(serviceInfo);
      }
    }
    
    return services;
  } catch (error) {
    configLogger.error({ error: error instanceof Error ? error.message : String(error), middlewarePath }, 'Failed to list service configurations');
    return [];
  }
}

