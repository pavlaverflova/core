import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { lambda } from "@pulumi/aws/types/input";
import { LambdaAuthorizer, Method } from "@pulumi/awsx/apigateway";
import { Parameter } from "@pulumi/awsx/apigateway/requestValidator";
import {
  Api,
  ApiRoute,
  CacheSettings,
  CustomDomainDistribution,
} from "@topmonks/pulumi-aws";
import * as path from "path";
import * as lambdaBuilder from "../lambda-builder";

const config = new pulumi.Config();

export const routes = new Map<string, Record<string, RouteArgs>>([
  [
    "v1",
    {
      auth: {
        httpMethod: "POST",
        path: "/auth",
        fileName: "auth/index.mjs",
        environment: {
          variables: {
            hostname: config.get("donut-domain"),
            private_key: config.get("private-key"),
            slack_client_id: config.get("slack-client-id"),
            slack_client_secret: config.get("slack-client-secret"),
          },
        },
      },
      registration: {
        httpMethod: "ANY",
        path: "/registration",
        fileName: "registration/index.mjs",
        environment: {
          variables: {
            hostname: config.get("web-domain"),
            donut: config.get("donut-domain"),
            private_key: config.get("private-key"),
            postmark_token: config.get("postmark-token"),
          },
        },
      },
      optout: {
        httpMethod: "POST",
        path: "/optout",
        fileName: "optout/index.mjs",
      },
      adminRegistrations: {
        httpMethod: "ANY",
        path: "/admin/registrations",
        fileName: "admin/registrations/index.mjs",
        environment: {
          variables: {
            private_key: config.get("private-key"),
          },
        },
      },
      ares: {
        httpMethod: "GET",
        path: "/ares",
        fileName: "ares/index.mjs",
        requiredParameters: [{ in: "query", name: "ico" }],
        cache: { ttl: 3600 },
        memorySize: 512,
      },
      fakturoidWebhook: {
        httpMethod: "POST",
        path: "/fakturoid/webhook",
        fileName: "fakturoid/webhook.mjs",
      },
      slackWebhook: {
        httpMethod: "POST",
        path: "/slack/webhook",
        fileName: "slack/webhook.mjs",
      },
    },
  ],
]);

function hcName(t: string, options?: any) {
  const suffix = options?.stage ? "-" + options?.stage : "";
  return `hc-${t}${suffix}`;
}

export function createDB() {
  const optOuts = new aws.dynamodb.Table(hcName("optouts"), {
    name: hcName("optouts"),
    hashKey: "email",
    rangeKey: "year",
    attributes: [
      { name: "email", type: "S" },
      { name: "year", type: "N" },
    ],
    billingMode: "PAY_PER_REQUEST",
  });

  const registrations = new aws.dynamodb.Table(hcName("registrations"), {
    name: hcName("registrations"),
    hashKey: "email",
    rangeKey: "year",
    attributes: [
      { name: "email", type: "S" },
      { name: "year", type: "N" },
    ],
    billingMode: "PAY_PER_REQUEST",
  });

  const contacts = new aws.dynamodb.Table(hcName("contacts"), {
    name: hcName("contacts"),
    hashKey: "email",
    rangeKey: "slackID",
    attributes: [
      { name: "email", type: "S" },
      { name: "slackID", type: "S" },
    ],
    billingMode: "PAY_PER_REQUEST",
  });

  const attendees = new aws.dynamodb.Table(hcName("attendees"), {
    name: hcName("attendees"),
    hashKey: "slackID",
    rangeKey: "year",
    attributes: [
      { name: "slackID", type: "S" },
      { name: "year", type: "N" },
    ],
    billingMode: "PAY_PER_REQUEST",
  });

  return pulumi.Output.create({
    registrationsDataTable: registrations.name,
    contactsDataTable: contacts.name,
    optOutsDataTable: optOuts.name,
    attributesDataTable: attendees.name,
  });
}

export function createApi(
  name: string,
  stage: string,
  domain: string,
  routes: Record<string, RouteArgs>
) {
  const defaultLambdaRole = new aws.iam.Role(
    hcName("default-lambda-role", { stage }),
    {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal(
        aws.iam.Principals.LambdaPrincipal
      ),
    }
  );

  new aws.iam.RolePolicyAttachment(
    hcName("lambda-basic-execution-attachment", { stage }),
    {
      policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
      role: defaultLambdaRole,
    }
  );

  new aws.iam.RolePolicyAttachment(
    hcName("lambda-dynamo-read-write-attachment", { stage }),
    {
      policyArn: aws.iam.ManagedPolicy.AmazonDynamoDBFullAccess,
      role: defaultLambdaRole,
    }
  );

  new aws.iam.RolePolicyAttachment(
    hcName("lambda-s3-read-attachment", { stage }),
    {
      policyArn: aws.iam.ManagedPolicy.AmazonS3ReadOnlyAccess,
      role: defaultLambdaRole,
    }
  );

  const buildAssets = (fileName: string) =>
    lambdaBuilder.buildCodeAsset(
      path.join(__dirname, "src", "lambda", fileName),
      {
        minify: false,
        format: "esm",
      }
    );

  const getRouteHandler = (
    name: string,
    fileName: string,
    role: aws.iam.Role,
    { environment, timeout = 15, memorySize = 128 }: RouteHandlerArgs
  ): aws.lambda.Function =>
    new aws.lambda.Function(hcName(`api-${name}-lambda`, { stage }), {
      publish: true,
      runtime: "nodejs16.x",
      architectures: ["arm64"],
      role: role.arn,
      handler: "index.handler",
      code: buildAssets(fileName),
      memorySize,
      timeout, // reasonable timeout for initial request without 500
      environment,
    });

  const createHandlerRoute = (
    name: string,
    {
      httpMethod,
      path,
      fileName,
      role,
      requiredParameters,
      cache,
      timeout,
      memorySize,
      authorizers,
      environment,
    }: RouteArgs
  ): ApiRoute => ({
    type: "handler",
    handler: getRouteHandler(name, fileName, role ?? defaultLambdaRole, {
      timeout: timeout ?? 15,
      memorySize,
      environment,
    }),
    cors: { methods: [httpMethod, "OPTIONS"] }, // autogenerate CORS handler
    authorizers,
    requiredParameters,
    httpMethod,
    path,
    cache,
  });

  const api = new Api(name, {
    stageName: stage,
    description: "HackerCamp API",
    cacheEnabled: true,
    cacheSize: "0.5", // GB
    routes: Object.entries(routes).map(([name, route]) =>
      createHandlerRoute(name, route)
    ),
  });

  const customDomainDistribution = new CustomDomainDistribution(
    name,
    {
      domainName: domain,
      basePath: stage,
      gateway: api.gateway,
    },
    { dependsOn: [api] }
  );

  return { url: customDomainDistribution.url };
}

interface RouteHandlerArgs {
  timeout?: number;
  environment?: lambda.FunctionEnvironment;
  memorySize?: number;
}

interface RouteArgs {
  httpMethod: Method;
  path: string;
  fileName: string;
  role?: aws.iam.Role;
  requiredParameters?: Parameter[];
  cache?: CacheSettings;
  timeout?: number;
  authorizers?: LambdaAuthorizer[] | LambdaAuthorizer;
  environment?: lambda.FunctionEnvironment;
  memorySize?: number;
}
