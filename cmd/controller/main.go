package main

import (
	"fmt"
	api "github.com/bartlapp/bartl-restic/api/v1alpha2"
	"github.com/bartlapp/bartl-restic/internal/controller"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/klog/v2/klogr"
	"os"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

func main() {
	ctrl.SetLogger(klogr.New())
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	ns, name := os.Getenv("WATCH_NAMESPACE"), os.Getenv("APPLICATION_NAME")
	if ns == "" || name == "" {
		return fmt.Errorf("WATCH_NAMESPACE and APPLICATION_NAME are required")
	}
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		return err
	}
	if err := api.AddToScheme(scheme); err != nil {
		return err
	}
	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{Scheme: scheme, Cache: cache.Options{DefaultNamespaces: map[string]cache.Config{ns: {}}, ByObject: map[client.Object]cache.ByObject{&api.ResticApplication{}: {Field: fields.OneTermEqualSelector("metadata.name", name)}}}, Metrics: metricsserver.Options{BindAddress: "0"}, HealthProbeBindAddress: ":8081", LeaderElection: true, LeaderElectionNamespace: ns, LeaderElectionID: name + ".restic.bartl.sh"})
	if err != nil {
		return err
	}
	direct, err := client.New(mgr.GetConfig(), client.Options{Scheme: scheme})
	if err != nil {
		return err
	}
	r := &controller.Reconciler{Client: direct, Scheme: scheme, Namespace: ns, Name: name}
	if err := r.Setup(mgr); err != nil {
		return err
	}
	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		return err
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		return err
	}
	return mgr.Start(ctrl.SetupSignalHandler())
}
