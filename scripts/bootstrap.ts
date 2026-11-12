#!/usr/bin/env bun
/**
 * Bootstrap Script - Unified Cluster Bootstrap and Destroy
 * 
 * Replaces:
 * - scripts/bootstrap.sh
 * - scripts/unbootstrap.sh
 * 
 * Features:
 * - Complete cluster bootstrap with ArgoCD
 * - Integrated GitHub App authentication setup
 * - Infrastructure and ApplicationSet deployment
 * - Destroy/unbootstrap operations
 * - Interactive prompts with validation
 * - Progress indicators and colored output
 * 
 * Usage:
 *   bun scripts/bootstrap.ts                    # Bootstrap cluster
 *   bun scripts/bootstrap.ts --wait             # Wait for full sync
 *   bun scripts/bootstrap.ts --destroy          # Destroy cluster
 *   bun scripts/bootstrap.ts --destroy --mode=cascade
 */

import { $ } from "bun";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import { parseArgs } from "util";

// ===== Types =====

interface BootstrapConfig {
  kubeconfig?: string;
  context?: string;
  skipArgoCD: boolean;
  skipGithubApp: boolean;
  wait: boolean;
  dryRun: boolean;
  autoApprove: boolean;
  
  githubApp?: {
    appId: string;
    installationId: string;
    privateKeyPath: string;
  };
  
  destroy: boolean;
  destroyMode?: 'cascade' | 'orphan' | 'argocd-only';
}

interface GitHubAppCredentials {
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

// ===== Bootstrap Class =====

class Bootstrap {
  private config: BootstrapConfig;

  constructor(config: BootstrapConfig) {
    this.config = config;
  }

  async run() {
    try {
      this.printHeader();
      
      if (this.config.destroy) {
        await this.destroy();
      } else {
        await this.bootstrap();
      }
    } catch (error) {
      console.error(chalk.red('\n✗ Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  // ===== Bootstrap Flow =====

  async bootstrap() {
    console.log(chalk.blue('\n==> Bootstrap Configuration'));
    console.log(`Kubeconfig: ${this.config.kubeconfig || process.env.KUBECONFIG || 'default'}`);
    console.log(`Wait for sync: ${this.config.wait}`);
    console.log(`Skip ArgoCD: ${this.config.skipArgoCD}`);
    console.log(`Skip GitHub App: ${this.config.skipGithubApp}`);
    console.log(`Dry run: ${this.config.dryRun}`);

    if (this.config.autoApprove) {
      console.log(chalk.yellow('\n⚠️  Auto-approve mode enabled'));
      console.log(chalk.yellow('⚠️  Skipping interactive confirmations'));
    }

    await this.validatePrerequisites();
    await this.selectContext();
    await this.setupGithubApp();
    
    if (!this.config.skipArgoCD) {
      await this.installArgoCD();
    }
    
    await this.bootstrapInfrastructure();
    
    if (this.config.wait) {
      await this.waitForSync();
    }
    
    await this.displayResults();
  }

  // ===== Validation =====

  async validatePrerequisites() {
    console.log(chalk.blue('\n==> Step 1: Validate Prerequisites'));
    
    const checks = [
      { name: 'kubectl', cmd: 'kubectl version --client --output=json' },
      { name: 'helm', cmd: 'helm version --short' },
    ];

    for (const check of checks) {
      try {
        const result = await $`${check.cmd.split(' ')}`.text();
        console.log(chalk.green(`✓ ${check.name} found`));
      } catch {
        throw new Error(`${check.name} not found in PATH`);
      }
    }

    // Check cluster connectivity
    try {
      await $`kubectl cluster-info`.quiet();
      console.log(chalk.green('✓ Connected to cluster'));
    } catch {
      throw new Error('Cannot connect to Kubernetes cluster');
    }
  }

  // ===== Context Selection =====

  async selectContext() {
    console.log(chalk.blue('\n==> Interactive Context Selection'));
    
    const contexts = await $`kubectl config get-contexts -o name`.text();
    const contextList = contexts.trim().split('\n');
    
    const currentContext = await $`kubectl config current-context`.text();
    const current = currentContext.trim();

    console.log(chalk.blue('Available contexts:'));
    contextList.forEach(ctx => {
      if (ctx === current) {
        console.log(chalk.green(`  * ${ctx} (current)`));
      } else {
        console.log(`    ${ctx}`);
      }
    });

    const clusterInfo = await $`kubectl cluster-info`.text();
    console.log(chalk.gray(`\nCluster: ${clusterInfo.split('\n')[0]}`));

    if (!this.config.autoApprove) {
      const useCurrentContext = await confirm({
        message: `Use current context: ${chalk.green(current)}?`,
        default: true
      });

      if (!useCurrentContext) {
        throw new Error('Context selection cancelled');
      }
    } else {
      console.log(chalk.yellow(`Using current context: ${current} (auto-approve mode)`));
    }

    this.config.context = current;
  }

  // ===== GitHub App Setup =====

  async checkIfRepoIsPublic(): Promise<boolean> {
    try {
      // Read ArgoCD values file to get the repository URL
      const valuesPath = 'values/infrastructure/main.yaml';
      const valuesContent = await Bun.file(valuesPath).text();

      // Extract repository URL from the repositories config
      // Format: - type: git\n        url: https://github.com/owner/repo.git
      const repoUrlMatch = valuesContent.match(/repositories:[\s\S]*?url:\s*(.+)/);
      if (!repoUrlMatch) {
        console.log(chalk.yellow('  Could not find repository URL in ArgoCD config'));
        return false;
      }

      const repoUrl = repoUrlMatch[1].trim();

      // Parse owner/repo from URL (handles both git@ and https://)
      const match = repoUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
      if (!match) {
        console.log(chalk.yellow('  Could not parse GitHub repository URL'));
        return false;
      }

      const [, owner, repo] = match;

      // Check GitHub API to see if repo is public
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`);

      if (response.ok) {
        const data = await response.json();
        return data.private === false;
      }

      return false;
    } catch (error) {
      console.log(chalk.yellow(`  Error checking repository: ${error instanceof Error ? error.message : error}`));
      return false;
    }
  }

  async setupGithubApp() {
    if (this.config.skipGithubApp) {
      console.log(chalk.yellow('\n⚠️  Skipping GitHub App setup'));
      return;
    }

    console.log(chalk.blue('\n==> Step 2: GitHub App Authentication'));

    // Check if repository is public
    const spinner = ora('Checking repository visibility...').start();
    const isPublic = await this.checkIfRepoIsPublic();

    if (isPublic) {
      spinner.succeed('Repository is public - GitHub App not required');
      console.log(chalk.gray('  ArgoCD can access public repositories without authentication'));
      return;
    }

    spinner.text = 'Checking for existing credentials...';

    try {
      // Check if credentials exist in GCP
      const secretsExist = await this.checkGCPSecrets([
        'argocd-github-app-id',
        'argocd-github-app-installation-id',
        'argocd-github-app-private-key'
      ]);

      if (secretsExist) {
        spinner.succeed('GitHub App credentials found in GCP Secret Manager');
        return;
      }

      spinner.fail('GitHub App credentials not found');
    } catch {
      spinner.fail('Could not check GCP secrets');
    }

    // Check if credentials provided via CLI
    if (this.config.githubApp) {
      await this.storeGithubAppCredentials(this.config.githubApp);
      await this.createExternalSecretManifest();
      return;
    }

    if (this.config.autoApprove) {
      console.log(chalk.yellow('⚠️  Auto-approve mode: Cannot setup GitHub App interactively'));
      console.log(chalk.yellow('⚠️  Provide credentials via --app-id, --installation-id, --private-key-path'));
      throw new Error('GitHub App credentials required');
    }

    // Interactive setup
    await this.setupGithubAppInteractive();
  }

  async setupGithubAppInteractive() {
    console.log(chalk.blue('\n📝 GitHub App Setup Required'));
    console.log('ArgoCD needs a GitHub App to access private repositories.\n');

    const setupNow = await confirm({
      message: 'Set up GitHub App authentication now?',
      default: true
    });

    if (!setupNow) {
      throw new Error('GitHub App setup required for private repository access');
    }

    this.displayGithubAppInstructions();

    await input({
      message: 'Press Enter when you have created the GitHub App...'
    });

    const credentials = await this.collectGithubAppCredentials();
    await this.validatePrivateKey(credentials.privateKeyPath);
    await this.storeGithubAppCredentials(credentials);
    await this.createExternalSecretManifest();

    console.log(chalk.green('\n✓ GitHub App configured successfully'));
  }

  displayGithubAppInstructions() {
    console.log(chalk.bold('\n1. Create GitHub App'));
    console.log(`   Go to: ${chalk.cyan('https://github.com/organizations/YOUR_ORG/settings/apps/new')}`);
    
    console.log(chalk.bold('\n2. Configure Permissions'));
    console.log('   Repository permissions:');
    console.log('   - Contents: Read-only');
    console.log('   - Metadata: Read-only');
    
    console.log(chalk.bold('\n3. After Creation'));
    console.log('   - Note the App ID');
    console.log('   - Generate and download private key (.pem file)');
    console.log('   - Install app to organization');
    console.log('   - Note the Installation ID from URL');
    console.log();
  }

  async collectGithubAppCredentials(): Promise<GitHubAppCredentials> {
    const appId = await input({
      message: 'Enter GitHub App ID:',
      validate: (val) => /^\d+$/.test(val) || 'Must be a number'
    });

    const installationId = await input({
      message: 'Enter Installation ID:',
      validate: (val) => /^\d+$/.test(val) || 'Must be a number'
    });

    const privateKeyPath = await input({
      message: 'Enter path to private key file:',
      default: '~/Downloads/*.private-key.pem'
    });

    return { appId, installationId, privateKeyPath };
  }

  async validatePrivateKey(path: string) {
    const expandedPath = path.replace('~', process.env.HOME || '~');
    
    try {
      const file = Bun.file(expandedPath);
      const content = await file.text();
      
      if (!content.includes('BEGIN RSA PRIVATE KEY') && !content.includes('BEGIN PRIVATE KEY')) {
        throw new Error('Invalid private key format');
      }
    } catch {
      throw new Error(`Cannot read private key at: ${expandedPath}`);
    }
  }

  async storeGithubAppCredentials(credentials: GitHubAppCredentials) {
    const spinner = ora('Storing credentials in GCP Secret Manager...').start();
    
    try {
      const expandedPath = credentials.privateKeyPath.replace('~', process.env.HOME || '~');

      // Store App ID
      try {
        await $`echo -n ${credentials.appId} | gcloud secrets create argocd-github-app-id --data-file=- --replication-policy=automatic`.quiet();
      } catch {
        // Secret might already exist, try to add new version
        await $`echo -n ${credentials.appId} | gcloud secrets versions add argocd-github-app-id --data-file=-`.quiet();
      }

      // Store Installation ID
      try {
        await $`echo -n ${credentials.installationId} | gcloud secrets create argocd-github-app-installation-id --data-file=- --replication-policy=automatic`.quiet();
      } catch {
        await $`echo -n ${credentials.installationId} | gcloud secrets versions add argocd-github-app-installation-id --data-file=-`.quiet();
      }

      // Store Private Key
      try {
        await $`cat ${expandedPath} | gcloud secrets create argocd-github-app-private-key --data-file=- --replication-policy=automatic`.quiet();
      } catch {
        await $`cat ${expandedPath} | gcloud secrets versions add argocd-github-app-private-key --data-file=-`.quiet();
      }

      spinner.succeed('Credentials stored in GCP Secret Manager');
    } catch (error) {
      spinner.fail('Failed to store credentials in GCP');
      throw error;
    }
  }

  async createExternalSecretManifest() {
    const manifest = `apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: argocd-github-app-creds
  namespace: argocd
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: gcp-secretstore
    kind: ClusterSecretStore
  target:
    name: github-repo-creds
    creationPolicy: Owner
    template:
      metadata:
        labels:
          argocd.argoproj.io/secret-type: repo-creds
      data:
        type: git
        url: https://github.com/YOUR_ORG
        githubAppID: "{{ .appId }}"
        githubAppInstallationID: "{{ .installationId }}"
        githubAppPrivateKey: "{{ .privateKey }}"
  data:
    - secretKey: appId
      remoteRef:
        key: argocd-github-app-id
    - secretKey: installationId
      remoteRef:
        key: argocd-github-app-installation-id
    - secretKey: privateKey
      remoteRef:
        key: argocd-github-app-private-key
`;

    const path = 'infrastructure/external-secrets/argocd-github-app-externalsecret.yaml';
    
    if (this.config.dryRun) {
      console.log(chalk.gray(`\nDry run: Would create ${path}`));
      return;
    }

    await Bun.write(path, manifest);
    console.log(chalk.green(`✓ Created ${path}`));
  }

  async checkGCPSecrets(secretNames: string[]): Promise<boolean> {
    try {
      for (const secret of secretNames) {
        await $`gcloud secrets describe ${secret}`.quiet();
      }
      return true;
    } catch {
      return false;
    }
  }

  // ===== ArgoCD Installation =====

  async installArgoCD() {
    console.log(chalk.blue('\n==> Step 3: Install ArgoCD'));
    
    if (this.config.dryRun) {
      console.log(chalk.gray('Dry run: Would install ArgoCD via Helm'));
      return;
    }

    const spinner = ora('Creating argocd namespace...').start();
    
    try {
      await $`kubectl create namespace argocd`.quiet();
      spinner.succeed('Namespace created');
    } catch {
      spinner.info('Namespace already exists');
    }

    spinner.start('Adding Argo Helm repository...');
    await $`helm repo add argo https://argoproj.github.io/argo-helm`.quiet();
    await $`helm repo update`.quiet();
    spinner.succeed('Helm repository added');

    spinner.start('Installing ArgoCD...');
    try {
      await $`helm upgrade --install argocd argo/argo-cd \
        --namespace argocd \
        --version 7.7.12 \
        --values values/infrastructure/main.yaml \
        --values values/infrastructure/argocd-helm.yaml \
        --wait \
        --timeout 10m`.quiet();
      
      spinner.succeed('ArgoCD installed successfully');
    } catch (error) {
      spinner.fail('ArgoCD installation failed');
      throw error;
    }

    // Wait for ArgoCD to be ready
    spinner.start('Waiting for ArgoCD pods...');
    await $`kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=argocd-server -n argocd --timeout=5m`.quiet();
    spinner.succeed('ArgoCD is ready');
  }

  // ===== Infrastructure Bootstrap =====

  async bootstrapInfrastructure() {
    console.log(chalk.blue('\n==> Step 4: Bootstrap Infrastructure'));
    
    if (this.config.dryRun) {
      console.log(chalk.gray('Dry run: Would deploy infrastructure and applications'));
      return;
    }

    const spinner = ora('Deploying ArgoCD Bootstrap (Infrastructure Root + ApplicationSet)...').start();

    try {
      await $`helm upgrade --install argocd-bootstrap ./charts/argocd-bootstrap \
        --namespace argocd \
        --values values/infrastructure/main.yaml \
        --wait \
        --timeout 5m`.quiet();
      spinner.succeed('ArgoCD Bootstrap deployed (Infrastructure Root + ApplicationSet)');
    } catch (error) {
      spinner.fail('ArgoCD Bootstrap deployment failed');
      throw error;
    }

    console.log(chalk.green('\n✓ Bootstrap complete'));
  }

  // ===== Wait for Sync =====

  async waitForSync() {
    console.log(chalk.blue('\n==> Waiting for Applications to sync...'));
    
    const spinner = ora('Syncing...').start();
    
    // Wait for infrastructure app
    try {
      await $`kubectl wait --for=condition=Synced application/infrastructure -n argocd --timeout=20m`.quiet();
      spinner.text = 'Infrastructure synced';
    } catch {
      spinner.warn('Infrastructure sync timeout (this may be normal)');
    }

    // Get all applications
    const apps = await $`kubectl get applications -n argocd -o name`.text();
    const appList = apps.trim().split('\n').filter(a => a);

    for (const app of appList) {
      spinner.text = `Syncing ${app}...`;
      try {
        await $`kubectl wait --for=condition=Synced ${app} -n argocd --timeout=10m`.quiet();
      } catch {
        // Continue even if some apps timeout
      }
    }

    spinner.succeed('Applications synced');
  }

  // ===== Display Results =====

  async displayResults() {
    console.log(chalk.blue('\n==> Deployment Summary'));
    
    try {
      const apps = await $`kubectl get applications -n argocd -o custom-columns=NAME:.metadata.name,HEALTH:.status.health.status,SYNC:.status.sync.status`.text();
      console.log(apps);
    } catch {
      console.log(chalk.yellow('Could not fetch application status'));
    }

    try {
      const lb = await $`kubectl get svc -n gateway-system -l gateway.envoyproxy.io/owning-gateway-name=shared-gateway -o jsonpath='{.items[0].status.loadBalancer.ingress[0].ip}'`.text();
      
      if (lb) {
        console.log(chalk.blue('\n==> LoadBalancer IP'));
        console.log(chalk.green(lb));
        console.log(chalk.gray(`\nConfigure DNS: *.example.com → ${lb}`));
      }
    } catch {
      console.log(chalk.yellow('\nLoadBalancer IP not yet available'));
    }

    console.log(chalk.blue('\n==> Next Steps'));
    console.log('1. Configure DNS records');
    console.log('2. Access ArgoCD: bun scripts/admin-access.ts argocd');
    console.log('3. Monitor deployments: kubectl get applications -n argocd');
  }

  // ===== Destroy Flow =====

  async destroy() {
    console.log(chalk.red('\n==> Unbootstrap / Destroy'));
    console.log(chalk.yellow('⚠️  This will remove ArgoCD and/or Applications\n'));

    // Select mode if not specified
    if (!this.config.destroyMode) {
      this.config.destroyMode = await select({
        message: 'Select destruction mode:',
        choices: [
          {
            name: 'cascade - Delete Applications AND all resources (DESTRUCTIVE)',
            value: 'cascade'
          },
          {
            name: 'orphan - Delete Applications but keep resources running',
            value: 'orphan'
          },
          {
            name: 'argocd-only - Only uninstall ArgoCD',
            value: 'argocd-only'
          }
        ]
      });
    }

    await this.confirmDestruction();
    await this.backupApplications();

    switch (this.config.destroyMode) {
      case 'cascade':
        await this.destroyCascade();
        break;
      case 'orphan':
        await this.destroyOrphan();
        break;
      case 'argocd-only':
        await this.destroyArgoCD();
        break;
    }

    console.log(chalk.green('\n✓ Destruction complete'));
  }

  async confirmDestruction() {
    if (this.config.autoApprove) {
      console.log(chalk.yellow('⚠️  Auto-approve enabled, skipping confirmation'));
      return;
    }

    const confirmation = await input({
      message: `Type "DELETE" to confirm ${chalk.red(this.config.destroyMode!)} mode:`,
      validate: (val) => val === 'DELETE' || 'Must type DELETE to confirm'
    });

    console.log(chalk.red('⚠️  Proceeding with destruction...'));
  }

  async backupApplications() {
    const spinner = ora('Backing up Applications...').start();
    
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = `backups/applications-${timestamp}`;
      
      await $`mkdir -p ${backupDir}`.quiet();
      
      try {
        await $`kubectl get applications -n argocd -o yaml > ${backupDir}/applications.yaml`.quiet();
      } catch {}
      
      try {
        await $`kubectl get applicationsets -n argocd -o yaml > ${backupDir}/applicationsets.yaml`.quiet();
      } catch {}
      
      spinner.succeed(`Applications backed up to ${backupDir}`);
    } catch (error) {
      spinner.warn('Backup failed (continuing anyway)');
    }
  }

  async destroyCascade() {
    console.log(chalk.red('\n==> Cascade Mode: Deleting Applications and Resources'));
    
    const spinner = ora('Deleting ApplicationSets...').start();
    try {
      await $`kubectl delete applicationsets -n argocd --all --cascade=foreground --timeout=10m`.quiet();
      spinner.succeed('ApplicationSets deleted');
    } catch {
      spinner.warn('ApplicationSets deletion had issues (continuing)');
    }

    spinner.start('Deleting Applications...');
    try {
      await $`kubectl delete applications -n argocd --all --cascade=foreground --timeout=10m`.quiet();
      spinner.succeed('Applications deleted');
    } catch {
      spinner.warn('Applications deletion had issues (continuing)');
    }

    await this.uninstallArgoCD();
    
    console.log(chalk.green('✓ Cascade deletion complete'));
  }

  async destroyOrphan() {
    console.log(chalk.yellow('\n==> Orphan Mode: Deleting Applications, keeping resources'));
    
    const spinner = ora('Deleting ApplicationSets (orphan)...').start();
    try {
      await $`kubectl delete applicationsets -n argocd --all --cascade=orphan`.quiet();
      spinner.succeed('ApplicationSets deleted (resources orphaned)');
    } catch {
      spinner.warn('ApplicationSets deletion had issues (continuing)');
    }

    spinner.start('Deleting Applications (orphan)...');
    try {
      await $`kubectl delete applications -n argocd --all --cascade=orphan`.quiet();
      spinner.succeed('Applications deleted (resources preserved)');
    } catch {
      spinner.warn('Applications deletion had issues (continuing)');
    }

    await this.uninstallArgoCD();
    
    console.log(chalk.green('✓ Orphan deletion complete (resources preserved)'));
  }

  async destroyArgoCD() {
    console.log(chalk.blue('\n==> ArgoCD Only Mode: Removing ArgoCD'));
    
    await this.uninstallArgoCD();
    
    console.log(chalk.green('✓ ArgoCD removed (Applications preserved)'));
  }

  async uninstallArgoCD() {
    const spinner = ora('Uninstalling ArgoCD...').start();
    
    try {
      await $`helm uninstall argocd -n argocd`.quiet();
      spinner.text = 'Deleting namespace...';
      await $`kubectl delete namespace argocd --timeout=5m`.quiet();
      spinner.succeed('ArgoCD uninstalled');
    } catch (error) {
      spinner.fail('ArgoCD uninstall had issues');
      throw error;
    }
  }

  // ===== Utility =====

  printHeader() {
    console.log(chalk.bold.blue('\n╔════════════════════════════════════════╗'));
    console.log(chalk.bold.blue('║  Monobase Infrastructure Bootstrap   ║'));
    console.log(chalk.bold.blue('╚════════════════════════════════════════╝\n'));
  }
}

// ===== CLI Parsing =====

function printHelp() {
  console.log(`
${chalk.bold('Monobase Infrastructure Bootstrap')}

${chalk.bold('USAGE:')}
  bun scripts/bootstrap.ts [OPTIONS]

${chalk.bold('OPTIONS:')}
  ${chalk.cyan('--help')}                    Show this help message
  ${chalk.cyan('--kubeconfig <path>')}       Path to kubeconfig file
  ${chalk.cyan('--context <name>')}          Kubernetes context to use
  ${chalk.cyan('--skip-argocd')}             Skip ArgoCD installation
  ${chalk.cyan('--skip-github-app')}         Skip GitHub App setup
  ${chalk.cyan('--wait')}                    Wait for applications to sync
  ${chalk.cyan('--dry-run')}                 Show what would be done
  ${chalk.cyan('--yes')}                     Auto-approve (non-interactive)
  
  ${chalk.bold('GitHub App Options:')}
  ${chalk.cyan('--app-id <id>')}             GitHub App ID
  ${chalk.cyan('--installation-id <id>')}    Installation ID
  ${chalk.cyan('--private-key-path <path>')} Path to private key file
  
  ${chalk.bold('Destroy Options:')}
  ${chalk.cyan('--destroy')}                 Unbootstrap cluster
  ${chalk.cyan('--mode <mode>')}             Destroy mode: cascade|orphan|argocd-only

${chalk.bold('EXAMPLES:')}
  ${chalk.gray('# Bootstrap cluster')}
  bun scripts/bootstrap.ts
  
  ${chalk.gray('# Bootstrap with wait')}
  bun scripts/bootstrap.ts --wait
  
  ${chalk.gray('# Bootstrap with GitHub App credentials')}
  bun scripts/bootstrap.ts --app-id 123 --installation-id 456 --private-key-path ~/key.pem
  
  ${chalk.gray('# Unbootstrap (cascade mode)')}
  bun scripts/bootstrap.ts --destroy --mode cascade
  
  ${chalk.gray('# Unbootstrap (orphan mode - keep resources)')}
  bun scripts/bootstrap.ts --destroy --mode orphan
`);
}

function parseCliArgs(): BootstrapConfig {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: 'boolean', default: false },
      kubeconfig: { type: 'string' },
      context: { type: 'string' },
      'skip-argocd': { type: 'boolean', default: false },
      'skip-github-app': { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'app-id': { type: 'string' },
      'installation-id': { type: 'string' },
      'private-key-path': { type: 'string' },
      destroy: { type: 'boolean', default: false },
      mode: { type: 'string' },
    },
    strict: true,
  });
  
  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const config: BootstrapConfig = {
    kubeconfig: values.kubeconfig,
    context: values.context,
    skipArgoCD: values['skip-argocd'] || false,
    skipGithubApp: values['skip-github-app'] || false,
    wait: values.wait || false,
    dryRun: values['dry-run'] || false,
    autoApprove: values.yes || false,
    destroy: values.destroy || false,
  };

  if (values['app-id'] && values['installation-id'] && values['private-key-path']) {
    config.githubApp = {
      appId: values['app-id'],
      installationId: values['installation-id'],
      privateKeyPath: values['private-key-path'],
    };
  }

  if (values.mode) {
    if (!['cascade', 'orphan', 'argocd-only'].includes(values.mode)) {
      throw new Error('Invalid mode. Must be: cascade, orphan, or argocd-only');
    }
    config.destroyMode = values.mode as 'cascade' | 'orphan' | 'argocd-only';
  }

  return config;
}

// ===== Main =====

async function main() {
  const config = parseCliArgs();
  const bootstrap = new Bootstrap(config);
  await bootstrap.run();
}

main();
