import { ClientToolImpl } from "./callClientTool";

export const askUserQuestionImpl: ClientToolImpl = async () => {
  return {
    respondImmediately: false,
    output: undefined,
  };
};
