#!/usr/bin/env node

import {program} from 'commander';
import execa from 'execa';

const getContainerName = (mysqlVersion: string) =>
  'docker-mysql-' + mysqlVersion.replace(/\./g, '-');
const mysqlRootPassword = 'docker-mysql-root-password';
const getPort = (mysqlVersion: string) => {
  if (mysqlVersion === 'latest') return '3306';
  // 3 + ゼロ埋めされた前三数字。
  return '3' + ('000' + mysqlVersion.replace(/\./g, '').slice(0, 3)).slice(-3);
};

const exec = async (
  command: string,
  args?: string[],
  options?: execa.Options
) => {
  return execa(command, args, {
    env: process.env,
    ...options,
  });
};

const execMysql = async (
  mysqlVersion: string,
  command: string,
  options?: execa.Options & {
    userName?: string;
    password?: string;
    databaseName?: string;
  }
) => {
  const newOptions = {...options};

  let userName = options?.userName;
  let password = options?.password;
  if (userName == null && password == null) {
    userName = 'root';
    password = mysqlRootPassword;
  }
  const database = options?.databaseName;

  delete newOptions.userName;
  delete newOptions.password;
  delete newOptions.databaseName;
  await exec(
    'docker',
    [
      'exec',
      '--env',
      `MYSQL_PWD=${password}`,
      getContainerName(mysqlVersion),
      'mysql',
      `--user=${userName}`,
      database || '',
      '-e',
      command,
    ],
    {env: process.env, ...newOptions}
  );
};

const retryCommand = async (
  commandCallback: () => Promise<void>,
  successErrorStr?: string
) => {
  return new Promise<void>(resolve => {
    const loop = () => {
      setTimeout(() => {
        void (async () => {
          await commandCallback()
            .then(() => {
              resolve();
            })
            .catch(e => {
              if (
                successErrorStr &&
                e.stderr.toString().includes(successErrorStr)
              ) {
                resolve();
                return;
              }
              loop();
            });
        })();
      }, 100);
    };
    loop();
  });
};

const createDatabase = async (mysqlVersion: string, name: string) => {
  console.info('Creating database ' + name + '...');
  await retryCommand(async () => {
    await execMysql(mysqlVersion, `create database ${name}`);
  }, 'database exists');
};

const createUser = async (
  mysqlVersion: string,
  name: string,
  password: string
) => {
  console.info('Creating user ' + name + '...');
  await retryCommand(async () => {
    await execMysql(
      mysqlVersion,
      `create user ${name} identified by '${password}'`
    );
  }, 'ERROR 1396');
};

const grantDatabaseToUser = async (
  mysqlVersion: string,
  userName: string,
  databaseName: string
) => {
  console.info(`Assign user ${userName} to database ${databaseName}...`);
  await retryCommand(async () => {
    await execMysql(
      mysqlVersion,
      `grant all on ${databaseName}.* to ${userName}`
    );
  });
};

const up = async (mysqlVersion: string) => {
  const running = await exec('docker', [
    'start',
    getContainerName(mysqlVersion),
  ])
    .then(() => true)
    .catch(() => false);
  if (running) return;

  await exec(
    'docker',
    [
      'run',
      '--name',
      getContainerName(mysqlVersion),
      '--env',
      `MYSQL_ROOT_PASSWORD=${mysqlRootPassword}`,
      '--publish',
      `${getPort(mysqlVersion)}:3306`,
      '--volume',
      `${getContainerName(mysqlVersion)}:/var/lib/mysql`,
      '-d',
      `mysql:${mysqlVersion}`,
    ],
    {env: process.env, stdio: 'inherit'}
  );
};

program
  .command('prepare <mysqlVersion> <databaseName>')
  .option('-u --userName <userName>')
  .option('-p --password <password>')
  .action(
    async (
      mysqlVersion: string,
      databaseName: string,
      {userName, password}: {userName?: string; password?: string}
    ) => {
      await up(mysqlVersion);
      await createDatabase(mysqlVersion, databaseName);

      const userCreated = userName && password;
      if (userCreated) await createUser(mysqlVersion, userName, password);
      if (userCreated)
        await grantDatabaseToUser(mysqlVersion, userName, databaseName);

      console.info(
        'Success: mysql is running on port ' + getPort(mysqlVersion)
      );
    }
  );

program
  .command('exec <mysqlVersion> <command...>')
  .option('-d --databaseName <databaseName>')
  .option('-u --userName <userName>')
  .option('-p --password <password>')
  .action(
    async (
      mysqlVersion: string,
      command: string[],
      options: {userName?: string; password?: string; databaseName?: string}
    ) => {
      await execMysql(mysqlVersion, command.join(' '), {
        stdio: 'inherit',
        ...options,
      });
    }
  );

program.command('stop <mysqlVersion>').action(async (mysqlVersion: string) => {
  await exec('docker', ['stop', getContainerName(mysqlVersion)]);
});

program
  .command('rm <mysqlVersion> <databaseName>')
  .option('-v --volume')
  .option('-u --userName <userName>')
  .option('-p --password <password>')
  .action(
    async (
      mysqlVersion: string,
      databaseName: string,
      options: {userName?: string; password?: string}
    ) => {
      await execMysql(
        mysqlVersion,
        `drop database ${databaseName}`,
        options
      ).catch(() => {});
    }
  );

program
  .command('down <mysqlVersion>')
  .option('-v --volume')
  .action(async (mysqlVersion: string, {volume}: {volume?: boolean}) => {
    await exec('docker', ['rm', '-f', getContainerName(mysqlVersion)]);
    if (volume) {
      await exec('docker', [
        'volume',
        'rm',
        '-f',
        getContainerName(mysqlVersion),
      ]);
    }
  });

program.parse(process.argv);
