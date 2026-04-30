'use strict';

const { GetParameterCommand } = require('@aws-sdk/client-ssm');

const GIT_TOKEN_PARAM_PATTERN = /^\/[\w-]+\/[\w-]+\/[\w-]+\/[\w-]+$/;

const resolveGitToken = async (ssm, item) => {
  if (item?.parameterName) {
    if (!GIT_TOKEN_PARAM_PATTERN.test(item.parameterName)) {
      throw new Error('Invalid SSM parameter name format');
    }
    const param = await ssm.send(new GetParameterCommand({ Name: item.parameterName, WithDecryption: true }));
    return JSON.parse(param.Parameter.Value).accessToken;
  }
  throw new Error('No SSM parameter name set');
};

module.exports = { resolveGitToken };
