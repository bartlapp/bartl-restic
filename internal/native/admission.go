package native

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"
)

const serviceAccountDirectory = "/var/run/secrets/kubernetes.io/serviceaccount"

type admission struct {
	client     *http.Client
	url        string
	pvcURL     string
	uid        string
	mode       string
	generation int64
	tokenFile  string
}

func newAdmission(mode string) (*admission, error) {
	name, namespace, uid := os.Getenv("APPLICATION_NAME"), os.Getenv("POD_NAMESPACE"), os.Getenv("APPLICATION_UID")
	if name == "" || namespace == "" || uid == "" {
		return nil, errors.New("missing application admission identity")
	}
	generation, err := strconv.ParseInt(os.Getenv("APPLICATION_GENERATION"), 10, 64)
	if err != nil || generation < 1 {
		return nil, errors.New("missing application execution generation")
	}
	ca, err := os.ReadFile(serviceAccountDirectory + "/ca.crt")
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("invalid Kubernetes CA")
	}
	return &admission{client: &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}, url: "https://kubernetes.default.svc/apis/restic.bartl.sh/v1alpha1/namespaces/" + url.PathEscape(namespace) + "/resticapplications/" + url.PathEscape(name), pvcURL: "https://kubernetes.default.svc/api/v1/namespaces/" + url.PathEscape(namespace) + "/persistentvolumeclaims/", uid: uid, mode: mode, generation: generation, tokenFile: serviceAccountDirectory + "/token"}, nil
}
func (a *admission) check(ctx context.Context) error {
	token, err := os.ReadFile(a.tokenFile)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+string(token))
	resp, err := a.client.Do(req)
	if err != nil {
		return fmt.Errorf("cannot establish current running intent: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("cannot establish current running intent: HTTP %d", resp.StatusCode)
	}
	var app struct {
		Metadata struct {
			UID               string  `json:"uid"`
			Generation        int64   `json:"generation"`
			DeletionTimestamp *string `json:"deletionTimestamp"`
		} `json:"metadata"`
		Spec struct {
			Replicas      *int   `json:"replicas"`
			ExistingClaim string `json:"existingClaim"`
		} `json:"spec"`
		Status struct {
			State              string `json:"state"`
			ObservedGeneration int64  `json:"observedGeneration"`
			Operation          *struct {
				Result     string `json:"result"`
				JobUID     string `json:"jobUID"`
				PVCUID     string `json:"pvcUID"`
				Generation int64  `json:"generation"`
			} `json:"operation"`
		} `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&app); err != nil {
		return err
	}
	if app.Metadata.UID != a.uid || app.Metadata.DeletionTimestamp != nil || app.Spec.Replicas == nil || *app.Spec.Replicas != 1 {
		return errors.New("current application intent refuses work")
	}
	if a.mode == "replicate" {
		op := app.Status.Operation
		if app.Metadata.Generation != a.generation || app.Status.State != "Ready" || app.Status.ObservedGeneration != app.Metadata.Generation {
			return errors.New("replication requires its admitted generation to be current and Ready")
		}
		if op == nil || op.Result != "Succeeded" || op.PVCUID != os.Getenv("PVC_UID") {
			return errors.New("replication no longer owns the verified target")
		}
	}
	if a.mode == "serve" {
		op := app.Status.Operation
		if op == nil || op.Result != "Succeeded" || op.PVCUID != os.Getenv("PVC_UID") {
			return errors.New("serving no longer owns the verified target")
		}
	}
	if a.mode == "lifecycle" {
		op := app.Status.Operation
		if op == nil || op.Result != "Running" || op.JobUID != os.Getenv("OPERATION_UID") || op.PVCUID != os.Getenv("PVC_UID") || op.Generation != app.Metadata.Generation {
			return errors.New("lifecycle operation no longer owns current application and target")
		}
	}
	if app.Spec.ExistingClaim == "" || os.Getenv("PVC_UID") == "" {
		return errors.New("missing live PVC execution identity")
	}
	req, err = http.NewRequestWithContext(ctx, http.MethodGet, a.pvcURL+url.PathEscape(app.Spec.ExistingClaim), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+string(token))
	pvcResp, err := a.client.Do(req)
	if err != nil {
		return fmt.Errorf("cannot establish current PVC ownership: %w", err)
	}
	defer pvcResp.Body.Close()
	if pvcResp.StatusCode != http.StatusOK {
		return fmt.Errorf("cannot establish current PVC ownership: HTTP %d", pvcResp.StatusCode)
	}
	var pvc struct {
		Metadata struct {
			UID               string            `json:"uid"`
			Annotations       map[string]string `json:"annotations"`
			DeletionTimestamp *string           `json:"deletionTimestamp"`
		} `json:"metadata"`
	}
	if err := json.NewDecoder(pvcResp.Body).Decode(&pvc); err != nil {
		return err
	}
	if pvc.Metadata.UID != os.Getenv("PVC_UID") || pvc.Metadata.Annotations["restic.bartl.sh/application-uid"] != a.uid || pvc.Metadata.DeletionTimestamp != nil {
		return errors.New("current PVC ownership refuses work")
	}
	return nil
}
func (a *admission) monitor(ctx context.Context, cancel context.CancelCauseFunc) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	defer a.client.CloseIdleConnections()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := a.check(ctx); err != nil {
				cancel(err)
				return
			}
		}
	}
}
