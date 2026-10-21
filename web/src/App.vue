<!--
  根组件
  ---------------------------------------------------------------
  只做两件事：1) 提供路由出口；2) 页面切换动画。
  布局由 layouts/MainLayout.vue 负责（登录页除外）。
-->
<template>
  <router-view v-slot="{ Component }">
    <transition name="fade-slide" mode="out-in">
      <component :is="Component" />
    </transition>
  </router-view>
</template>
