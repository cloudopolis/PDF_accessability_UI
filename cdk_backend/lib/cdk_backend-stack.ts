import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as amplify from '@aws-cdk/aws-amplify-alpha';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';

export class CdkBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    
    const bucketName = this.node.tryGetContext('bucketName');
    const githubToken = this.node.tryGetContext('githubToken');
    const githubRepoOwner = this.node.tryGetContext('githubRepoOwner');

    if (!githubToken || !bucketName || !githubRepo) {
      throw new Error(
        'Both GitHub token, repo owner, and bucket name are required! Pass them using `-c githubToken=<token> -c bucketName=<name>-c githubRepoOwner=<name>`'
      );
    }

    const bucket = s3.Bucket.fromBucketName(this, 'ImportedBucket', bucketName);
    console.log(`Using bucket: ${bucket.bucketName}`);
    
    const githubToken_secret_manager = new secretsmanager.Secret(this, 'GitHubToken', {
      secretName: 'pdfui-github-token',
      description: 'GitHub Personal Access Token for Amplify',
      secretStringValue: cdk.SecretValue.unsafePlainText(githubToken)
    });

    // --------- Create Amplify App (WITHOUT referencing the domain yet) ----------
    const amplifyApp = new amplify.App(this, 'pdfui', {
      sourceCodeProvider: new amplify.GitHubSourceCodeProvider({
        
        owner: githubRepoOwner,
        repository: 'PDF_accessability_UI',
        oauthToken: githubToken_secret_manager.secretValue
      }),
      buildSpec: cdk.aws_codebuild.BuildSpec.fromObjectToYaml({
        version: '1.0',
        frontend: {
          phases: {
            preBuild: {
              commands: ['cd pdf_ui', 'npm ci']
            },
            build: {
              commands: ['npm run build']
            }
          },
          artifacts: {
            baseDirectory: 'pdf_ui/build',
            files: ['**/*']
          },
          cache: {
            paths: ['pdf_ui/node_modules/**/*']
          }
        }
      }),
    });

    // VERY VERY IMPORANT THIS RULE IS STILL IMPORANT BUT PLEASE KEEP IN MIND THIS RULE NEEDS TO BE ADDED 
    // AFTER THE APPLICATION IS DONE BUILDING AND NEEDS TO BE DELETED BEFORE DEPLOYING A NEW UPDATE 
    // AND THEN NEEDS TO BE RE ADDED

    // amplifyApp.addCustomRule({
    //   source: '/<*>',
    //   target: '/index.html',
    //   status: amplify.RedirectStatus.REWRITE
    // });


    // Create main branch
    const mainBranch = amplifyApp.addBranch('main', {
      autoBuild: true,
      stage: 'PRODUCTION'
    });

    const domainPrefix = 'pdf-ui-auth'; // must be globally unique in that region
    const Default_Group = 'DefaultUsers';
    const Amazon_Group = 'AmazonUsers';
    const Admin_Group = 'AdminUsers';
    const appUrl = `https://main.${amplifyApp.appId}.amplifyapp.com`;
    
    // Create the Lambda role first with necessary permissions
    const postConfirmationLambdaRole = new iam.Role(this, 'PostConfirmationLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    postConfirmationLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminAddUserToGroup',
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents'
        ],
        resources: ['*']  // You can restrict this further if needed
      })
    );

    // Create the Lambda with the role
    const postConfirmationFn = new lambda.Function(this, 'PostConfirmationLambda', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/postConfirmation/'),
      timeout: cdk.Duration.seconds(30),
      role: postConfirmationLambdaRole,
      environment: {
        DEFAULT_GROUP_NAME: Default_Group,
        AMAZON_GROUP_NAME: Amazon_Group,
        ADMIN_GROUP_NAME: Admin_Group,
      },
    });

    // ------------------- Cognito: User Pool, Domain, Client -------------------
    const userPool = new cognito.UserPool(this, 'PDF-Accessability-User-Pool', {
      userPoolName: 'PDF-Accessability-User-Pool',
      selfSignUpEnabled: true,
      signInAliases: { email: true },

      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: false,
        requireUppercase: false,
      },
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: true, mutable: true },
        familyName: { required: true, mutable: true },

      },
      customAttributes: {
        first_sign_in: new cognito.BooleanAttribute({ mutable: true }),
        total_files_uploaded: new cognito.NumberAttribute({ mutable: true }),
        max_files_allowed: new cognito.NumberAttribute({ mutable: true }),
        max_pages_allowed: new cognito.NumberAttribute({ mutable: true }),
        max_size_allowed_MB: new cognito.NumberAttribute({ mutable: true }),
        organization: new cognito.StringAttribute({ mutable: true }),
        country: new cognito.StringAttribute({ mutable: true }),
        state: new cognito.StringAttribute({ mutable: true }),
        city: new cognito.StringAttribute({ mutable: true }),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      lambdaTriggers: {
        postConfirmation: postConfirmationFn,
      },
    });
    
    // ------------------- Cognito: User Groups -------------------
      const defaultUsersGroup = new cognito.CfnUserPoolGroup(this, 'Default_Group', {
        groupName: Default_Group,
        userPoolId: userPool.userPoolId,
        description: 'Group for default or normal users',
        precedence: 1, // Determines the priority of the group
      });

      // Amazon Users Group
      const amazonUsersGroup = new cognito.CfnUserPoolGroup(this, 'AmazonUsersGroup', {
        groupName: Amazon_Group,
        userPoolId: userPool.userPoolId,
        description: 'Group for Amazon Employees',
        precedence: 2,
      });

      // Admin Users Group
      const adminUsersGroup = new cognito.CfnUserPoolGroup(this, 'AdminUsersGroup', {
        groupName: Admin_Group,
        userPoolId: userPool.userPoolId,
        description: 'Group for admin users with elevated permissions',
        precedence: 0, // Higher precedence means higher priority
      });

    // Domain prefix is defined above with appUrl
    const userPoolDomain = new cognito.CfnUserPoolDomain(this, 'PDF-Accessability-User-Pool-Domain', {
      domain: domainPrefix,
      userPoolId: userPool.userPoolId,
      managedLoginVersion: 2,
    });

    const userPoolClient = userPool.addClient('PDF-Accessability-User-Pool-Client', {
      userPoolClientName: 'PDF-Accessability-User-Pool-Client',
      authFlows: {
        userSrp: true,
        userPassword: true,
        adminUserPassword: true
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PHONE,
          cognito.OAuthScope.PROFILE
        ],
        callbackUrls: [`${appUrl}/callback`,"http://localhost:3000/callback"],
        logoutUrls: [`${appUrl}/home`, "http://localhost:3000/home"],
      },
      generateSecret: false,
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ]
    });

    

    // (Optional) If CfnManagedLoginBranding is not critical, remove it or put it in a separate stack
    const managed_login = new cognito.CfnManagedLoginBranding(this, 'MyManagedLoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      returnMergedResources: true,
      useCognitoProvidedValues: true,
      
    });

    // ------------- Identity Pool + IAM Roles for S3 Access --------------------
    const identityPool = new cognito.CfnIdentityPool(this, 'PDFIdentityPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName,
        },
      ],
    });

    const authenticatedRole = new iam.Role(this, 'CognitoDefaultAuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:PutObject',
          's3:PutObjectAcl',
          's3:GetObject',
        ],
        resources: [
          bucket.bucketArn + '/*',
        ],
      }),
    );

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: identityPool.ref,
      roles: {
        authenticated: authenticatedRole.roleArn,
      },
    });



    // ------------------- Lambda Function for Post Confirmation -------------------
    const updateAttributesFn = new lambda.Function(this, 'UpdateAttributesFn', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/updateAttributes/'),
      timeout: cdk.Duration.seconds(30),
      role: postConfirmationLambdaRole,
      environment: {
        USER_POOL_ID: userPool.userPoolId, // used in index.py
      },
    });

    const checkUploadQuotaLambdaRole = new iam.Role(this, 'CheckUploadQuotaLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // 2) Attach necessary policies
    checkUploadQuotaLambdaRole.addToPolicy(new iam.PolicyStatement({
      resources: ['*'],
      actions: [
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminUpdateUserAttributes',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents'
      ],
    }));

    // 3) Create the Lambda function
    const checkOrIncrementQuotaFn = new lambda.Function(this, 'checkOrIncrementQuotaFn', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/checkOrIncrementQuota'),  
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      role: checkUploadQuotaLambdaRole,
      environment: {
        USER_POOL_ID: userPool.userPoolId  
      }
    });

    const updateAttributesApi = new apigateway.RestApi(this, 'UpdateAttributesApi', {
      restApiName: 'UpdateAttributesApi',
      description: 'API to update Cognito user attributes (org, first_sign_in,country, state, city, total_file_uploaded).',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },

    });

    // 3) Create a Cognito Authorizer (User Pool Authorizer) referencing our user pool
    const userPoolAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'UserPoolAuthorizer', {
      cognitoUserPools: [userPool], // array of user pools
    });

    // 4) Add Resource & Method
    const UpdateFirstSignIn = updateAttributesApi.root.addResource('update-first-sign-in');
    const quotaResource = updateAttributesApi.root.addResource('upload-quota');
    // We attach the Cognito authorizer and set the authorizationType to COGNITO
    UpdateFirstSignIn.addMethod('POST', new apigateway.LambdaIntegration(updateAttributesFn), {
      authorizer: userPoolAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    quotaResource.addMethod('POST', new apigateway.LambdaIntegration(checkOrIncrementQuotaFn), {
      authorizer: userPoolAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });


    // const hostedUiDomain = `https://pdf-ui-auth.auth.${this.region}.amazoncognito.com/login/continue?client_id=${userPoolClient.userPoolClientId}&redirect_uri=https%3A%2F%2Fmain.${amplifyApp.appId}.amplifyapp.com&response_type=code&scope=email+openid+phone+profile`
    const Authority = `cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;

    // ------------------ Pass environment variables to Amplify ------------------
    mainBranch.addEnvironment('REACT_APP_BUCKET_NAME', bucket.bucketName);
    mainBranch.addEnvironment('REACT_APP_BUCKET_REGION', this.region);
    mainBranch.addEnvironment('REACT_APP_AWS_REGION', this.region);
    
    mainBranch.addEnvironment('REACT_APP_USER_POOL_ID', userPool.userPoolId);
    mainBranch.addEnvironment('REACT_APP_AUTHORITY', Authority);

    mainBranch.addEnvironment('REACT_APP_USER_POOL_CLIENT_ID', userPoolClient.userPoolClientId);
    mainBranch.addEnvironment('REACT_APP_IDENTITY_POOL_ID', identityPool.ref);
    mainBranch.addEnvironment('REACT_APP_HOSTED_UI_URL', appUrl);
    mainBranch.addEnvironment('REACT_APP_DOMAIN_PREFIX', domainPrefix);

    mainBranch.addEnvironment('REACT_APP_UPDATE_FIRST_SIGN_IN', updateAttributesApi.urlForPath('/update-first-sign-in'));
    mainBranch.addEnvironment('REACT_APP_UPLOAD_QUOTA_API', updateAttributesApi.urlForPath('/upload-quota'));
    // Grant Amplify permission to read the secret
    githubToken_secret_manager.grantRead(amplifyApp);


     // ------------------- Integration of UpdateAttributesGroups Lambda -------------------
    // 1. Create IAM Role
    const updateAttributesGroupsLambdaRole = new iam.Role(this, 'UpdateAttributesGroupsLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for UpdateAttributesGroups Lambda function',
    });

    updateAttributesGroupsLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:ListUsersInGroup',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminListGroupsForUser',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        //cloudwatch logs
      
      ],
      resources: [
        userPool.userPoolArn,
        `${userPool.userPoolArn}/*` // Allows access to all resources within the User Pool
      ],
    }));

    // 2. Create the Lambda function
    const updateAttributesGroupsFn = new lambda.Function(this, 'UpdateAttributesGroupsFn', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/UpdateAttributesGroups/'), // Ensure this path is correct
      timeout: cdk.Duration.seconds(900),
      role: updateAttributesGroupsLambdaRole,
    });


    const cognitoTrail = new cloudtrail.Trail(this, 'CognitoTrail', {
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
    });
    
    // Remove the incorrect event selector
    // No need to add specific data resource for Cognito events
    
    const cognitoGroupChangeRule = new events.Rule(this, 'CognitoGroupChangeRule', {
      eventPattern: {
        source: ['aws.cognito-idp'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventName: ['AdminAddUserToGroup', 'AdminRemoveUserFromGroup'],
          requestParameters: {
            userPoolId: [userPool.userPoolId],
          },
        },
      },
    });
    
    cognitoGroupChangeRule.addTarget(new targets.LambdaFunction(updateAttributesGroupsFn));
    
    updateAttributesGroupsFn.addPermission('AllowEventBridgeInvoke', {
      principal: new iam.ServicePrincipal('events.amazonaws.com'),
      sourceArn: cognitoGroupChangeRule.ruleArn,
    });
    
    // --------------------------- Outputs ------------------------------
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'UserPoolDomain', { value: domainPrefix });
    new cdk.CfnOutput(this, 'IdentityPoolId', { value: identityPool.ref });
    new cdk.CfnOutput(this, 'AuthenticatedRole', { value: authenticatedRole.roleArn });
    new cdk.CfnOutput(this, 'AmplifyAppURL', {
      value: appUrl,
      description: 'Amplify Application URL',
    });
    new cdk.CfnOutput(this, 'UpdateFirstSignInEndpoint', {
      value: updateAttributesApi.urlForPath('/update-first-sign-in'),
      description: 'POST requests to this URL to update attributes.',
    });

    new cdk.CfnOutput(this, 'CheckUploadQuotaEndpoint', {
      value: updateAttributesApi.urlForPath('/upload-quota'),
    });


  }
}
