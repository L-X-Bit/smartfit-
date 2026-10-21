<!--
  根组件
  ---------------------------------------------------------------
  三件事：
    1) 用 ElConfigProvider 注入中文语言包
       —— 按需引入模式下不再全局 app.use(ElementPlus)，
       日期选择器 / 分页等组件的内置文案需要通过 ConfigProvider 提供，否则会显示英文；
    2) 提供路由出口；
    3) 页面切换动画。
  布局由 layouts/MainLayout.vue 负责（登录页除外）。
-->
<template>
  <el-config-provider :locale="zhCn">
    <router-view v-slot="{ Component }">
      <transition name="fade-slide" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
  </el-config-provider>
</template>

<script setup>
import zhCn from 'element-plus/es/locale/lang/zh-cn';
</script>
