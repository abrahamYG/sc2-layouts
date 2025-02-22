# StarCraft II Layouts

Visual Studio Code extension introducing extensive support for **SC2Layout** language, utilized in games like StarCraft II and Heroes of the Storm.

> Schema files of `SC2Layout` are hosted in its own [repository](https://github.com/SC2Mapster/sc2layout-schema), from which this extension will always pull most recent version.

## Contribution guide

**Requirements**

 * yarn: https://yarnpkg.com

**Initial setup**
```
git clone https://github.com/Talv/sc2-layouts.git
cd sc2-layouts
git submodule update
yarn install
```

**Dev tasks**

* `yarn run build:watch` - compile `.ts` files and watch for changes
* `yarn run test` - run tests

**Testing extension in VSCode**

https://code.visualstudio.com/api/working-with-extensions/testing-extension

## Showcase

### Code completions

![completions-tooltips](./assets/completions-tooltips.png)

![completions-enum](./assets/completions-enum.png)

![completions-frametype](./assets/completions-frametype.png)

![completions-assets](./assets/completions-assets.png)

![completions-selectors](./assets/completions-selectors.png)

![completions-templates](./assets/completions-templates.png)

### Goto definition

![image](./assets/definition-selectors.png)

### Document and workspace navigation

![image](./assets/document-navigation.png)

![image](./assets/workspace-navigation-constants.png)

### Code diagnostics

![image](./assets/diagnostics-overview.png)
